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
import { Task, launchPrompt } from "./tasks";
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
    `Original request:\n${run?.prompt || launchPrompt(task)}`,
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
