// Agent-review model: turns a finished task into a prompt and a task card for a
// reviewer agent. Pure, so the rules live here rather than in a component.
//
// Argv safety: prompts reach the CLI as one argument, capped at 32 KiB on
// Windows, and a batch-script agent still runs through `cmd.exe /c`, which
// refuses the quotes, `%`, `&`, `|` and line breaks a diff is full of. The
// reviewer prompt must therefore never embed diff text or agent output. It holds
// only fixed text, the user's own request and change request, sanitised file
// paths, status words and an exit code; the reviewer reads the diff itself.

import { AgentConfig } from "./agents";
import { DEFAULT_REVIEW_INSTRUCTIONS } from "./settings";
import { Task, VERDICT_SUMMARY_MAX, Verdict, launchPrompt } from "./tasks";
import { RunRecord } from "./usage";

export interface ReviewFile {
  path: string;
  status: string;
}

/** Most files listed in a review prompt; the rest are summarised as a count. */
export const REVIEW_FILE_LIMIT = 40;
/** Longest path kept in a review prompt, ellipsis included. */
export const REVIEW_PATH_LIMIT = 200;

export interface ReviewContext {
  /** The task under review. */
  task: Task;
  builderName: string;
  /** Its latest finished run, if any. */
  run?: RunRecord;
  /** Undefined = no capture available. Only `path` and `status` are read. */
  files?: ReviewFile[];
  /** `settings.reviewInstructions`; blank falls back to the built-in checklist. */
  instructions: string;
}

const STATUSES = ["added", "modified", "deleted"];

function fileLine(file: ReviewFile): string {
  const status = STATUSES.includes(file.status) ? file.status : "changed";
  const path = file.path.replace(/[\u0000-\u001f\u007f]/g, "");
  const shown =
    path.length > REVIEW_PATH_LIMIT
      ? `${path.slice(0, REVIEW_PATH_LIMIT - 1)}…`
      : path;
  return `- ${status}: ${shown}`;
}

/** The prompt for a reviewer agent. Never embeds diff text or agent output. */
export function buildReviewPrompt({
  task,
  builderName,
  run,
  files,
  instructions,
}: ReviewContext): string {
  const where = task.worktree
    ? "The builder worked in an isolated Git worktree, which is your working folder. Run git status and git diff HEAD, and look at untracked files too, to see everything it changed."
    : "The builder worked in the shared project folder. Run git status and git diff. Edits that were already there before the run may also appear, so focus on the files listed below.";
  let changed: string;
  if (!files)
    changed =
      "No file list was captured for this run; inspect the working tree directly.";
  else if (!files.length)
    changed =
      "The run's snapshot recorded no text-file changes; check whether the request was carried out.";
  else {
    const lines = files.slice(0, REVIEW_FILE_LIMIT).map(fileLine);
    if (files.length > REVIEW_FILE_LIMIT)
      lines.push(`- …and ${files.length - REVIEW_FILE_LIMIT} more`);
    changed = `Files changed during the run (${files.length}):\n${lines.join("\n")}`;
  }
  const ended =
    typeof run?.exitCode === "number"
      ? `The builder's process exited with code ${run.exitCode}.`
      : run
        ? `The builder's run ended as: ${run.outcome}.`
        : undefined;
  return [
    `Review the work another coding agent (${builderName}) did for the task below. Do not modify, create or delete files and do not commit — report findings only.`,
    `Task: ${task.title}`,
    // A teammate's run also sent a preface (who it is, its memory and inbox);
    // the reviewer needs only what was asked.
    `Original request:\n${run?.request || run?.prompt || launchPrompt(task)}`,
    `Where to look:\n${where}`,
    changed,
    ended,
    `Review instructions:\n${instructions.trim() || DEFAULT_REVIEW_INSTRUCTIONS}`,
  ]
    .filter((section) => section !== undefined)
    .join("\n\n");
}

/**
 * The board card for a review. Headless and never isolated: the reviewer must
 * see the builder's files, not a fresh worktree of its own.
 */
export function reviewTaskFor(
  task: Task,
  run: RunRecord | undefined,
  reviewerAgentId: string,
  prompt: string,
  ids: { id: string; now: number },
): Task {
  return {
    id: ids.id,
    title: `Review: ${task.title}`,
    prompt,
    agentId: reviewerAgentId,
    cwd: run?.cwd || task.worktree || task.cwd || undefined,
    mode: "headless",
    status: "backlog",
    projectId: task.projectId,
    priority: task.priority ?? "normal",
    createdAt: ids.now,
    reviewOf: task.id,
    isolation: false,
    dependencies: [],
  };
}

/**
 * Default reviewer: an enabled agent other than the builder (a second opinion),
 * else the builder itself, else nothing.
 */
export function pickReviewer(
  agents: AgentConfig[],
  builderAgentId: string,
): string | undefined {
  const enabled = agents.filter((a) => a.enabled);
  return (enabled.find((a) => a.id !== builderAgentId) ?? enabled[0])?.id;
}

/** Live (non-archived) review tasks of `taskId`, in board order. */
export function reviewsOf(tasks: Task[], taskId: string): Task[] {
  return tasks.filter((t) => t.reviewOf === taskId && !t.archived);
}

/** Terminal output as plain text: escape sequences removed, CR as a line break. */
export function plainOutput(text: string): string {
  return text
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export type ParsedVerdict = Pick<Verdict, "decision" | "summary">;

/**
 * A verdict line: optional Markdown decoration and a `Verdict:` label, then the
 * keyword, then whatever the reviewer wrote after it on the same line.
 */
const VERDICT_LINE =
  /^[\s>#*_`-]*(?:(?:final\s+)?(verdict)\b[\s*_`]*[:\-–—]?[\s*_`]*)?(approved?|request(?:ed)?\s+changes|changes\s+requested)\b[\s*_`]*(.*)$/i;
/** Lines a CLI prints around the answer: Codex's role markers and token count. */
const CLI_MARKER =
  /^(?:codex|user|thinking|exec|tokens used\b.*|[\d,]+|-{3,})$/i;
/** Lines of findings taken from before the verdict when nothing follows it. */
const VERDICT_CONTEXT_LINES = 80;

const trimBlank = (lines: string[]) => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
};

/**
 * Read a reviewer's verdict from its run output: the last line that starts with
 * APPROVE or REQUEST CHANGES. Without a `Verdict:` label the keyword must be
 * upper case, so prose like "Approve the PR once…" is not a verdict. Lines that
 * also appear in `prompt` are skipped, because Codex echoes the prompt and the
 * review instructions may contain such a line. Findings are what follows the
 * verdict, or the block before it when nothing does.
 */
export function parseVerdict(
  output: string,
  prompt = "",
): ParsedVerdict | undefined {
  const lines = plainOutput(output)
    .split("\n")
    .map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
  const echoed = new Set(
    prompt
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || echoed.has(line)) continue;
    const match = VERDICT_LINE.exec(line);
    if (!match) continue;
    const [, label, keyword, rest] = match;
    if (!label && keyword !== keyword.toUpperCase()) continue;
    const inline = rest.replace(/^[\s:.,;–—-]+/, "").replace(/[\s*_`]+$/, "");
    const following = lines.slice(i + 1);
    const stop = following.findIndex((l) => CLI_MARKER.test(l.trim()));
    const after = trimBlank(stop < 0 ? following : following.slice(0, stop));
    let summary = (inline ? [inline, ...after] : after).join("\n");
    if (!summary.trim()) {
      const before: string[] = [];
      for (
        let j = i - 1;
        j >= 0 && before.length < VERDICT_CONTEXT_LINES;
        j--
      ) {
        if (CLI_MARKER.test(lines[j].trim())) break;
        before.unshift(lines[j]);
      }
      summary = trimBlank(before).join("\n");
    }
    summary = summary.trim();
    if (summary.length > VERDICT_SUMMARY_MAX)
      summary = `${summary.slice(0, VERDICT_SUMMARY_MAX - 1).trimEnd()}…`;
    return {
      decision: /^approve/i.test(keyword) ? "approve" : "changes",
      summary,
    };
  }
  return undefined;
}

export const VERDICT_LABELS: Record<Verdict["decision"], string> = {
  approve: "Approved",
  changes: "Changes requested",
};

/**
 * Prefill for the Request changes form: the reviewer's findings, after any
 * change request already pending so neither is lost.
 */
export function changeRequestFrom(
  pending: string | undefined,
  verdict: Pick<Verdict, "summary">,
): string {
  const current = pending?.trim();
  const findings = verdict.summary.trim();
  if (!current) return findings;
  if (!findings || current.includes(findings)) return current;
  return `${current}\n\n${findings}`;
}
