// Task model for the Kanban board. Kept in its own module so App.tsx stays
// focused on wiring; the board UI and App both import from here.

export type TaskStatus = "backlog" | "running" | "review" | "done";
export type TaskMode = "interactive" | "headless";

/** Longest reviewer findings kept; they can prefill a change request. */
export const VERDICT_SUMMARY_MAX = 4000;

/** What an agent reviewer concluded, read from the last line of its output. */
export interface Verdict {
  decision: "approve" | "changes";
  /** The reviewer's findings, plain text, capped at VERDICT_SUMMARY_MAX. */
  summary: string;
  /** The review run it was read from. */
  runId: string;
  at: number;
}

export interface Task {
  /** Stable, non-time-based id (`task-N`) so behavior is testable. */
  id: string;
  title: string;
  prompt: string;
  /** References an AgentConfig id from the agent catalog (src/agents.ts). */
  agentId: string;
  /** Optional working-dir override; absent = inherit the shared default cwd. */
  cwd?: string;
  /** interactive = stays running for steering; headless = exits when done. */
  mode: TaskMode;
  status: TaskStatus;
  /** Slot id this task is bound to while running. */
  paneId?: string;
  /** Wanted to run but every pane was busy. */
  queued?: boolean;
  /**
   * Exit code of the last headless run, recorded when the process ends
   * (0 = ok badge, anything else = failed). Cleared on the next launch.
   */
  lastExitCode?: number;
  projectId?: string;
  priority?: "high" | "normal" | "low";
  createdAt?: number;
  archived?: boolean;
  interrupted?: boolean;
  attention?: string;
  dependencies?: string[];
  isolation?: boolean;
  worktree?: string;
  reviewNotes?: string;
  reviewedAt?: number;
  /**
   * Feedback from "Request changes"; appended to every launch prompt until the
   * task is marked done or the request is cleared.
   */
  changeRequest?: string;
  /** On an agent-review task: the id of the task whose work it reviews. */
  reviewOf?: string;
  /** On an agent-review task: the verdict read from its last run. */
  verdict?: Verdict;
}

/** The fields a user edits in the composer; the rest are managed by App. */
export interface TaskDraft {
  title: string;
  prompt: string;
  agentId: string;
  cwd?: string;
  mode: TaskMode;
  priority?: Task["priority"];
  dependencies?: string[];
  isolation?: boolean;
}

/** Board columns, left-to-right, with the order used by the ◀ ▶ move buttons. */
export const TASK_COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "running", label: "Running" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

export const COLUMN_ORDER: TaskStatus[] = TASK_COLUMNS.map((c) => c.id);

export const CHANGE_REQUEST_HEADING = "Changes requested after review:";

/**
 * The prompt a launch actually sends: the original request plus any pending
 * change request. Every launch path must use this, never `task.prompt`
 * directly, or review feedback silently stops reaching the agent.
 */
export function launchPrompt(
  task: Pick<Task, "prompt" | "changeRequest">,
): string {
  const feedback = task.changeRequest?.trim();
  if (!feedback) return task.prompt;
  return `${task.prompt.trimEnd()}\n\n${CHANGE_REQUEST_HEADING}\n${feedback}`;
}

/**
 * Pick only the fields the composer owns. A `Task` also carries runtime state
 * (status, paneId, queued, worktree, review notes) that must never travel
 * inside a draft or template: spreading a stale snapshot back over the live
 * task reverts whatever changed while the dialog was open, and a stray `id`
 * would make a "new" task collide with the one it was drafted from.
 */
export function draftFromTask(source: Task | TaskDraft): TaskDraft {
  return {
    title: source.title,
    prompt: source.prompt,
    agentId: source.agentId,
    cwd: source.cwd,
    mode: source.mode,
    priority: source.priority ?? "normal",
    dependencies: [...(source.dependencies ?? [])],
    isolation: source.isolation ?? false,
  };
}
