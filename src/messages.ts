// Teammate messaging. Pure: App owns the state, desktop.rs moves a run's inbox
// and outbox files in and out of its folder, and every rule about reading an
// outbox, delivering an inbox, and when a message may start a task lives here.
//
// Argv safety: a message body is written by an agent (or the owner) and can
// hold anything, so it only ever travels in files. A prompt carries the
// folder's path, teammate names and a count, never a body.

import { Task } from "./tasks";
import { OnMessage, Teammate, nameList } from "./teammates";

/** `from` of a message the owner wrote on the Teammates page. */
export const OWNER = "owner";

export interface TeamMessage {
  id: string;
  /** A teammate id, or OWNER. */
  from: string;
  /** The sender's name when it was sent; shown if the sender is deleted. */
  fromName: string;
  /** A teammate id. */
  to: string;
  body: string;
  at: number;
  /** Where the sender was working; a task the message starts runs there. */
  projectId?: string;
  cwd?: string;
  /** The run that sent it; absent for the owner's messages. */
  runId?: string;
  /**
   * Its place in a chain of messages: 1 when the owner wrote it or a run the
   * owner started sent it, one more for each message-started run since.
   */
  hop: number;
  deliveredAt?: number;
  /** The recipient's run it was delivered to. */
  deliveredRunId?: string;
  /** The task started to handle it. */
  taskId?: string;
}

/** Longest message kept, ellipsis included. */
export const BODY_MAX = 4000;
/** Most messages one run sends; a message to several teammates counts each. */
export const SEND_MAX = 10;
/** Most messages delivered to one run; the rest wait for the next. */
export const INBOX_MAX = 20;
/** Messages kept in history; delivered ones are dropped first. */
export const MESSAGES_KEPT = 500;
/** Longest quote of the recipient's own last message, given as context. */
export const QUOTE_MAX = 600;

/** The request of a task started by a message: fixed text, no message body. */
export const MESSAGE_TASK_PROMPT =
  "Read the new messages in your inbox and act on them. If a sender asked for an answer, reply through your outbox.";

/** Line endings unified, control characters other than tab and newline gone. */
export const cleanText = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

/** Cap a body at BODY_MAX, cutting with an ellipsis. */
export const capBody = (body: string) =>
  body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1)}…` : body;

/** Blank lines at either end dropped, trailing spaces trimmed, then capped. */
export function tidyBody(text: string): string {
  const lines = cleanText(text)
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return capBody(lines.join("\n"));
}

/** A message read from an outbox, before App gives it an id and a time. */
export interface OutboxDraft {
  /** The recipient's teammate id. */
  to: string;
  body: string;
}

export interface OutboxRead {
  drafts: OutboxDraft[];
  /** Things the owner should hear about: unknown names, the send limit. */
  problems: string[];
}

/** Identity of a draft, so a run never sends the same message twice. */
export const draftKey = (draft: OutboxDraft) =>
  `${draft.to}\u0000${draft.body}`;

const EVERYONE = new Set([
  "everyone",
  "everybody",
  "all",
  "all teammates",
  "the team",
  "team",
]);
// `## To: Ben`, `**To:** Ben`, `To: Ben, Cleo`. Markdown emphasis is removed
// before matching, so `**To: Ben**` works too.
const HEADER = /^\s{0,3}(#{1,6}\s*)?to\s*:\s*(.+)$/i;
/** A name as written, without the punctuation around it. */
const bareName = (name: string) =>
  name.replace(/^[\s@"'“”‘’<[(]+|[\s"'“”‘’>\]).,:;!]+$/g, "");

interface Recipients {
  ids: string[];
  unknown: string[];
  /** The header names the sender itself. */
  self: boolean;
}

/**
 * The recipients a header names. A name may trail a note ("Ben (re: auth)"):
 * the longest teammate name it starts with, followed by a non-letter, wins.
 */
function recipients(
  list: string,
  sender: string,
  team: Pick<Teammate, "id" | "name">[],
): Recipients | undefined {
  const named = team
    .map((t) => ({ id: t.id, name: t.name.trim().toLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length);
  const exact = (name: string) =>
    named.find((t) => t.name === name.toLowerCase())?.id;
  const find = (name: string) => {
    const lower = name.toLowerCase();
    return (
      exact(name) ??
      named.find(
        (t) =>
          lower.startsWith(t.name) &&
          !/[\p{L}\p{N}]/u.test(lower.charAt(t.name.length)),
      )?.id
    );
  };
  const everyone = (name: string) => EVERYONE.has(name.toLowerCase());
  // A whole-line match first, so a name holding "and" or a comma still works;
  // only single names may trail a note, or "Ben and Cleo" would read as Ben.
  const whole = bareName(list);
  const names =
    exact(whole) || everyone(whole)
      ? [whole]
      : list
          .split(/\s*(?:,|;|&|\+|\band\b)\s*/i)
          .map(bareName)
          .filter(Boolean);
  if (!names.length) return undefined;
  const ids: string[] = [];
  const unknown: string[] = [];
  let self = false;
  for (const name of names) {
    const id = find(name);
    if (id === sender) self = true;
    else if (id) ids.push(id);
    else if (everyone(name)) {
      for (const t of team) if (t.id !== sender) ids.push(t.id);
    } else unknown.push(name);
  }
  return { ids: [...new Set(ids)], unknown, self };
}

/**
 * Read a run's outbox. Messages start at a `To:` line (a heading, as the
 * prompt asks, or bold); a bare `To:` line counts only when every name on it
 * is a teammate, so prose such as "To: be fair" stays in the body. Text before
 * the first header is the teammate's own and is ignored.
 *
 * `sent` holds the keys this run already sent: those are skipped, and only
 * SEND_MAX messages in all leave one run.
 */
export function readOutbox(
  text: string,
  sender: Pick<Teammate, "id" | "name">,
  team: Pick<Teammate, "id" | "name">[],
  sent: ReadonlySet<string> = new Set(),
): OutboxRead {
  const problems: string[] = [];
  const unknown = new Set<string>();
  const found: OutboxDraft[] = [];
  let current: string[] | undefined;
  let body: string[] = [];
  const flush = () => {
    if (current) {
      const tidy = tidyBody(body.join("\n"));
      if (tidy) for (const to of current) found.push({ to, body: tidy });
    }
    body = [];
  };
  for (const line of cleanText(text).split("\n")) {
    const bare = line.replace(/[*_`]/g, "");
    const match = HEADER.exec(bare);
    const marked = Boolean(match?.[1]) || /^\s{0,3}[*_]/.test(line);
    const who = match && recipients(match[2], sender.id, team);
    if (
      who &&
      (marked || (!who.unknown.length && (who.ids.length || who.self)))
    ) {
      flush();
      current = who.ids;
      for (const name of who.unknown) unknown.add(name);
      continue;
    }
    body.push(line);
  }
  flush();
  for (const name of unknown) problems.push(`No teammate is called “${name}”.`);
  const seen = new Set(sent);
  const fresh = found.filter((draft) => {
    const key = draftKey(draft);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const room = Math.max(0, SEND_MAX - sent.size);
  if (fresh.length > room) {
    const over = fresh.length - room;
    problems.push(
      `${over} more message${over === 1 ? " was" : "s were"} not sent: one run sends at most ${SEND_MAX}.`,
    );
  }
  return { drafts: fresh.slice(0, room), problems };
}

const when = (at: number) =>
  `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const quote = (text: string) =>
  (text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX - 1)}…` : text)
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

/** The name shown for a message's sender: its current name when it still exists. */
export function senderName(
  m: Pick<TeamMessage, "from" | "fromName">,
  team: Pick<Teammate, "id" | "name">[],
): string {
  if (m.from === OWNER) return "the owner";
  return team.find((t) => t.id === m.from)?.name ?? m.fromName;
}

/**
 * The inbox.md a run is seeded with: each message with who sent it, when and
 * from which project. A message from a teammate also quotes the recipient's
 * own last message to that teammate before it, so a reply has its context.
 */
export function inboxText(
  recipient: Pick<Teammate, "id" | "name">,
  delivered: TeamMessage[],
  history: TeamMessage[],
  team: Pick<Teammate, "id" | "name">[],
  projects: { id: string; name: string }[],
): string {
  const count =
    delivered.length === 1
      ? "1 new message"
      : `${delivered.length} new messages`;
  const sections = [
    `# Messages for ${recipient.name}`,
    `${count}, oldest first. Messages from the owner come from the person you work for.`,
  ];
  for (const m of [...delivered].sort((a, b) => a.at - b.at)) {
    const project = projects.find((p) => p.id === m.projectId)?.name;
    const from = senderName(m, team);
    sections.push(
      `## From ${from}, ${when(m.at)}${project ? `, project “${project}”` : ""}`,
      m.body,
    );
    if (m.from === OWNER) continue;
    const mine = history
      .filter((h) => h.from === recipient.id && h.to === m.from && h.at < m.at)
      .sort((a, b) => a.at - b.at)
      .pop();
    if (mine)
      sections.push(
        `> Your last message to ${from}, for context:\n${quote(mine.body)}`,
      );
  }
  return `${sections.join("\n\n")}\n`;
}

/**
 * What a recipient's run receives: its waiting messages, oldest first, up to
 * INBOX_MAX, always including the messages a task was started for (even when
 * an earlier run already got them).
 */
export function messagesToDeliver(
  messages: TeamMessage[],
  recipientId: string,
  include: readonly string[] = [],
): TeamMessage[] {
  const wanted = new Set(include);
  const mine = messages
    .filter((m) => m.to === recipientId && (!m.deliveredAt || wanted.has(m.id)))
    .sort((a, b) => a.at - b.at);
  return [
    ...mine.filter((m) => wanted.has(m.id)),
    ...mine.filter((m) => !wanted.has(m.id)),
  ]
    .slice(0, INBOX_MAX)
    .sort((a, b) => a.at - b.at);
}

export const waitingFor = (messages: TeamMessage[], teammateId: string) =>
  messages.filter((m) => m.to === teammateId && !m.deliveredAt).length;

/** The hop of a message sent from a run of this task (or by the owner). */
export const nextHop = (task?: Pick<Task, "hop">) => (task?.hop ?? 0) + 1;

/** Whether a message starts a task for its recipient, and if not, why. */
export type Arrival = "start" | "hold" | "paused" | "chain";
export function arrival(
  recipient: { onMessage: OnMessage },
  hop: number,
  settings: { messageStarts: boolean; messageChainLimit: number },
): Arrival {
  if (recipient.onMessage !== "start") return "hold";
  if (!settings.messageStarts) return "paused";
  return hop > settings.messageChainLimit ? "chain" : "start";
}

/** "Message from Ada", "Messages from Ada and Ben". */
export function messageTaskTitle(senders: string[], count: number): string {
  const unique = [...new Set(senders)];
  const shown =
    unique.length > 3
      ? `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} others`
      : nameList(unique);
  return `${count === 1 ? "Message" : "Messages"} from ${shown}`;
}

/**
 * A board card that starts a recipient on its messages: headless, never
 * isolated (it works in the sender's folder, beside what the sender did), and
 * as deep in the chain as its deepest message.
 */
export function messageTaskFor(
  recipient: Pick<Teammate, "id" | "agentId">,
  messages: TeamMessage[],
  team: Pick<Teammate, "id" | "name">[],
  where: { projectId: string; cwd?: string },
  ids: { id: string; now: number },
): Task {
  return {
    id: ids.id,
    title: messageTaskTitle(
      messages
        .map((m) => senderName(m, team))
        .map((n) => (n === "the owner" ? "you" : n)),
      messages.length,
    ),
    prompt: MESSAGE_TASK_PROMPT,
    agentId: recipient.agentId,
    teammateId: recipient.id,
    cwd: where.cwd || undefined,
    mode: "headless",
    status: "backlog",
    projectId: where.projectId,
    priority: "normal",
    createdAt: ids.now,
    isolation: false,
    dependencies: [],
    messageIds: messages.map((m) => m.id),
    hop: Math.max(1, ...messages.map((m) => m.hop)),
  };
}

/**
 * The message task a new message should join instead of starting another:
 * the recipient's, in the same project and folder, not started yet.
 */
export function pendingMessageTask(
  tasks: Task[],
  recipientId: string,
  where: { projectId: string; cwd?: string },
): Task | undefined {
  return tasks.find(
    (t) =>
      t.teammateId === recipientId &&
      t.messageIds?.length &&
      t.status === "backlog" &&
      !t.paneId &&
      !t.archived &&
      t.projectId === where.projectId &&
      (t.cwd ?? "") === (where.cwd ?? ""),
  );
}

/** The folder a task runs in: its worktree, its own folder, or its project's. */
const folderOf = (t: Task, projects: { id: string; cwd: string }[]) =>
  t.worktree || t.cwd || projects.find((p) => p.id === t.projectId)?.cwd || "";

/**
 * A message task waits while its teammate already has a run going in the same
 * folder, so a teammate works through its messages one batch at a time instead
 * of two copies of it editing the same files. New messages join the waiting
 * task meanwhile (pendingMessageTask).
 */
export function messageTaskWaits(
  task: Task,
  tasks: Task[],
  projects: { id: string; cwd: string }[],
): boolean {
  if (!task.messageIds || !task.teammateId) return false;
  const where = folderOf(task, projects);
  return tasks.some(
    (t) =>
      t.id !== task.id &&
      t.teammateId === task.teammateId &&
      Boolean(t.paneId) &&
      folderOf(t, projects) === where,
  );
}

/**
 * Validate a persisted message list. Messages to a teammate that no longer
 * exists are dropped; a deleted sender keeps its name snapshot.
 */
export function normalizeMessages(
  raw: unknown,
  teammateIds: ReadonlySet<string>,
): TeamMessage[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const out: TeamMessage[] = [];
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const time = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const at = time(m.at);
    if (
      typeof m.id !== "string" ||
      !m.id ||
      ids.has(m.id) ||
      typeof m.to !== "string" ||
      !teammateIds.has(m.to) ||
      typeof m.from !== "string" ||
      !m.from ||
      m.from === m.to ||
      typeof m.body !== "string" ||
      !m.body.trim() ||
      at === undefined
    )
      continue;
    ids.add(m.id);
    const hop = time(m.hop);
    const deliveredAt = time(m.deliveredAt);
    out.push({
      id: m.id,
      from: m.from,
      fromName:
        m.from === OWNER
          ? "You"
          : (text(m.fromName)?.slice(0, 40) ?? "A former teammate"),
      to: m.to,
      body: capBody(cleanText(m.body)),
      at,
      projectId: text(m.projectId),
      cwd: text(m.cwd),
      runId: text(m.runId),
      hop: hop === undefined ? 1 : Math.min(99, Math.max(1, Math.round(hop))),
      deliveredAt,
      deliveredRunId: deliveredAt ? text(m.deliveredRunId) : undefined,
      taskId: text(m.taskId),
    });
  }
  return retainMessages(out.sort((a, b) => a.at - b.at));
}

/** Keep the newest MESSAGES_KEPT, dropping delivered messages before waiting ones. */
export function retainMessages(messages: TeamMessage[]): TeamMessage[] {
  let extra = messages.length - MESSAGES_KEPT;
  if (extra <= 0) return messages;
  const dropped = new Set<string>();
  for (const pass of [true, false])
    for (const m of messages) {
      if (extra <= 0) break;
      if (dropped.has(m.id) || Boolean(m.deliveredAt) !== pass) continue;
      dropped.add(m.id);
      extra--;
    }
  return messages.filter((m) => !dropped.has(m.id));
}
