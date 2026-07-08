// Task model for the Kanban board. Kept in its own module so App.tsx stays
// focused on wiring; the board UI and App both import from here.

export type TaskStatus = "backlog" | "running" | "review" | "done";
export type TaskMode = "interactive" | "headless";

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
}

/** The fields a user edits in the composer; the rest are managed by App. */
export interface TaskDraft {
  title: string;
  prompt: string;
  agentId: string;
  cwd?: string;
  mode: TaskMode;
}

/** Board columns, left-to-right, with the order used by the ◀ ▶ move buttons. */
export const TASK_COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "running", label: "Running" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

export const COLUMN_ORDER: TaskStatus[] = TASK_COLUMNS.map((c) => c.id);
