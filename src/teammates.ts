// Teammates: saved, named agents with a brief and a memory of their own. Pure:
// App owns the state, desktop.rs moves a run's files in and out of its folder,
// and every rule about names, prompts and merging lives here.
//
// Argv safety: the memory (like a message, see messages.ts) is written by
// agents and can hold anything, so it never goes into a prompt; the prompt
// carries only relative paths, names and counts. The brief is the owner's own
// text, like a task prompt, and is capped.

import { AgentConfig } from "./agents";

/** What a message to the teammate does: wait for its next task, or start one. */
export type OnMessage = "hold" | "start";

export interface Teammate {
  id: string;
  name: string;
  /** Engine: an AgentConfig id. Changing it keeps the name, brief and memory. */
  agentId: string;
  /** What the teammate owns, its standards, and when to stop and ask. */
  brief: string;
  /** Notes the teammate keeps for itself; they follow it across projects. */
  memory: string;
  memoryUpdatedAt?: number;
  /** Its runs get an outbox and are told who they can write to. */
  canMessage: boolean;
  onMessage: OnMessage;
  createdAt: number;
}

export const NAME_MAX = 40;
export const BRIEF_MAX = 2000;
export const MEMORY_MAX = 16000;
/**
 * Where a teammate run's files live, relative to the run's folder: one
 * subfolder per run (see runFolder), kept out of Git by desktop.rs.
 */
export const CRUCIBLE_DIR = ".crucible";

/**
 * Characters a name may not use. Names travel in every teammate's prompt, and
 * cmd.exe (which runs a batch-script agent) refuses a prompt holding them.
 */
const UNSAFE_NAME = /["%!^&|<>\u0000-\u001f\u007f]/g;

export function teammateNameError(
  name: string,
  teammates: Pick<Teammate, "id" | "name">[],
  id?: string,
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Give the teammate a name.";
  if (trimmed.length > NAME_MAX)
    return `Keep the name to ${NAME_MAX} characters.`;
  if (new RegExp(UNSAFE_NAME.source).test(trimmed))
    return 'Names cannot use " % ! ^ & | < or >.';
  const taken = teammates.some(
    (t) => t.id !== id && t.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return taken ? "Another teammate already has this name." : undefined;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/**
 * The run's own folder under CRUCIBLE_DIR: a slug of the teammate's name plus
 * the end of the run id. One folder per run, so two runs of one teammate in
 * the same project never share (and overwrite) a memory file. Only `[a-z0-9-]`,
 * which desktop.rs checks again.
 */
export function runFolder(t: Pick<Teammate, "name">, runId: string): string {
  const tail =
    runId
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(-8) || "0";
  return `${slug(t.name) || "teammate"}-${tail}`;
}

/** "Ben", "Ben and Cleo", "Ben, Cleo and Dan". */
export function nameList(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface TeammateRun {
  /** The run's folder name (runFolder), under CRUCIBLE_DIR. */
  folder: string;
  /** Messages delivered in its inbox.md; 0 = no inbox. */
  inbox: number;
  /** Teammates it can write to; empty = no outbox. */
  team: string[];
}

/**
 * The prompt a teammate's run sends: who it is, its brief, where its memory,
 * inbox and outbox are and how to use them, then the task. Never the memory or
 * a message itself.
 */
export function teammatePrompt(
  t: Pick<Teammate, "name" | "brief">,
  prompt: string,
  run: TeammateRun,
): string {
  const brief = t.brief.trim();
  const dir = `${CRUCIBLE_DIR}/${run.folder}`;
  const many = run.inbox === 1 ? "1 new message" : `${run.inbox} new messages`;
  return [
    `You are ${t.name.trim()}, a teammate working through Crucible.`,
    brief ? `Your brief:\n${brief}` : undefined,
    `Your memory from earlier work, across projects, is in ${dir}/memory.md (paths are relative to this folder). Read it before you start. When you learn something that should still matter on future work (a preference, a decision, a convention, a pitfall), add it there as a short line. Keep it current: fix or remove lines that turn out to be wrong. Never store secrets in it.`,
    run.inbox > 0
      ? `You have ${many} from the team in ${dir}/inbox.md. Read ${run.inbox === 1 ? "it" : "them"} before you start: act on what bears on this task, and keep lasting lessons in your memory.`
      : undefined,
    run.team.length
      ? // No quotes or angle brackets: they are what cmd.exe refuses in argv.
        `You can message your teammates (${nameList(run.team)}): a lesson that applies to their work, a question, or a request. Write each message in ${dir}/outbox.md below a heading line naming who it is for, such as ## To: ${run.team[0]} (## To: everyone reaches them all). Crucible delivers it when you finish a turn, and they read it when they next start work, so do not wait for a reply. Keep messages short and self-contained, and never include secrets.`
      : undefined,
    `Task:\n${prompt}`,
  ]
    .filter((section) => section !== undefined)
    .join("\n\n");
}

export interface MemoryMerge {
  memory: string;
  /** The stored memory is different afterwards. */
  changed: boolean;
  /** Oldest lines were dropped to stay under MEMORY_MAX. */
  trimmed: boolean;
}

const unify = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
const lines = (text: string) => text.split("\n");

/** Drop whole lines from the top until the text fits. */
function cap(text: string): { text: string; trimmed: boolean } {
  if (text.length <= MEMORY_MAX) return { text, trimmed: false };
  const kept = lines(text);
  let length = text.length;
  while (kept.length > 1 && length > MEMORY_MAX)
    length -= kept.shift()!.length + 1;
  const joined = kept.join("\n");
  return {
    text: joined.length > MEMORY_MAX ? joined.slice(-MEMORY_MAX) : joined,
    trimmed: true,
  };
}

/**
 * Fold what a run left in its memory file back into the stored memory.
 *
 * - `returned` missing, or the same as what was seeded: nothing changes.
 * - The stored memory is still what was seeded: the file replaces it, so the
 *   teammate can rewrite and prune its own notes.
 * - The stored memory changed during the run (edited by the owner, or another
 *   run merged first): only lines the run added are appended, so neither side's
 *   work is lost.
 */
export function mergeMemory(
  seeded: string,
  current: string,
  returned: string | null | undefined,
): MemoryMerge {
  const unchanged = { memory: current, changed: false, trimmed: false };
  if (returned === null || returned === undefined) return unchanged;
  const back = unify(returned).trimEnd();
  const seed = unify(seeded).trimEnd();
  if (back === seed) return unchanged;
  let next: string;
  if (unify(current).trimEnd() === seed) next = back;
  else {
    const known = new Set(
      [...lines(seed), ...lines(unify(current))]
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const added: string[] = [];
    for (const line of lines(back)) {
      const key = line.trim();
      if (!key || known.has(key)) continue;
      known.add(key);
      added.push(line);
    }
    if (!added.length) return unchanged;
    next = [current.trimEnd(), ...added].filter(Boolean).join("\n");
  }
  const { text, trimmed } = cap(next);
  return { memory: text, changed: text !== current, trimmed };
}

/**
 * Validate a persisted teammate list. Engines that left the catalog fall back
 * to its first entry; names stay unique; text fields are capped.
 */
export function normalizeTeammates(
  raw: unknown,
  agents: AgentConfig[],
): Teammate[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const out: Teammate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || !t.id || ids.has(t.id)) continue;
    let name = (typeof t.name === "string" ? t.name : "")
      .replace(UNSAFE_NAME, "")
      .trim()
      .slice(0, NAME_MAX);
    if (!name) continue;
    const base = name;
    for (let n = 2; teammateNameError(name, out); n++)
      name = `${base.slice(0, NAME_MAX - String(n).length - 1)} ${n}`;
    const memory = typeof t.memory === "string" ? unify(t.memory) : "";
    ids.add(t.id);
    out.push({
      id: t.id,
      name,
      agentId:
        typeof t.agentId === "string" && agents.some((a) => a.id === t.agentId)
          ? t.agentId
          : (agents[0]?.id ?? ""),
      brief: (typeof t.brief === "string" ? t.brief : "").slice(0, BRIEF_MAX),
      memory: cap(memory).text,
      memoryUpdatedAt:
        typeof t.memoryUpdatedAt === "number" &&
        Number.isFinite(t.memoryUpdatedAt)
          ? t.memoryUpdatedAt
          : undefined,
      canMessage: t.canMessage !== false,
      onMessage: t.onMessage === "start" ? "start" : "hold",
      createdAt:
        typeof t.createdAt === "number" && Number.isFinite(t.createdAt)
          ? t.createdAt
          : Date.now(),
    });
  }
  return out;
}
