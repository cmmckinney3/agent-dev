// Run-history model behind the Usage page. Every agent launch is recorded as
// a RunRecord — which agent, from where (manual pane start or a task card),
// when, for how long, and how it ended — persisted with the workspace and
// capped by the retention setting. Aggregation and formatting live here so App.tsx
// stays focused on wiring.

import { TaskMode } from "./tasks";

/** How a run ended (or that it hasn't yet). */
export type RunOutcome =
  | "running" // live right now
  | "completed" // process exited on its own (exitCode says how)
  | "stopped" // stopped from the app (Stop button, restart, task moved out)
  | "interrupted"
  | "failed";

export interface RunRecord {
  /** Stable id (`run-N`), monotonic like task/agent ids. */
  id: string;
  agentId: string;
  /** Name snapshot at launch, so history survives catalog renames/deletes. */
  agentName: string;
  slotId: string;
  /** Session title snapshot at launch (slots can be renamed or closed later). */
  session: string;
  /** Set when the run was launched from a task card. */
  taskId?: string;
  taskTitle?: string;
  /** Task run mode; absent for manual pane starts (always interactive). */
  mode?: TaskMode;
  startedAt: number;
  /** Absent while running and for interrupted runs. */
  endedAt?: number;
  exitCode?: number;
  outcome: RunOutcome;
  projectId?: string;
  cwd?: string;
  model?: string;
  program?: string;
  prompt?: string;
  error?: string;
  resumeId?: string;
  /** Set when a teammate did the run; the name is a snapshot, like agentName. */
  teammateId?: string;
  teammateName?: string;
}

/**
 * Launch attribution passed through AgentPane.start and echoed back on the
 * "running" status change. Explicit (rather than read from slot state in App)
 * for the same reason task launches pass program/cwd: the slot's agent is
 * updated by a setState that may not have committed when the status fires.
 */
export interface RunMeta {
  agentId: string;
  taskId?: string;
  taskTitle?: string;
  mode?: TaskMode;
}

/**
 * Hard ceiling on stored records. The effective limit is `usageLimit` in
 * Settings (History & data); this is the largest value it can be set to, and
 * what a persisted blob is trimmed to on load.
 */
export const MAX_RUN_RECORDS = 2000;

const OUTCOMES: readonly RunOutcome[] = [
  "running",
  "completed",
  "stopped",
  "interrupted",
  "failed",
];

/**
 * Validate a persisted history (tolerant per-field, like normalizeAgents).
 * Runs that were live when the app closed come back as `interrupted`; their
 * duration is unknowable, so they keep no endedAt and never count toward
 * session-time totals.
 */
export function normalizeRuns(raw: unknown): RunRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .filter(
      (r) =>
        typeof r.id === "string" &&
        typeof r.agentId === "string" &&
        typeof r.startedAt === "number" &&
        Number.isFinite(r.startedAt),
    )
    .map((r): RunRecord => {
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const num = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      const stored = OUTCOMES.includes(r.outcome as RunOutcome)
        ? (r.outcome as RunOutcome)
        : "interrupted";
      return {
        id: r.id as string,
        agentId: r.agentId as string,
        agentName: str(r.agentName) ?? (r.agentId as string),
        slotId: str(r.slotId) ?? "",
        session: str(r.session) ?? "",
        taskId: str(r.taskId),
        taskTitle: str(r.taskTitle),
        mode:
          r.mode === "interactive" || r.mode === "headless" ? r.mode : undefined,
        startedAt: r.startedAt as number,
        endedAt: num(r.endedAt),
        exitCode: num(r.exitCode),
        outcome: stored === "running" ? "interrupted" : stored,
        projectId: str(r.projectId), cwd: str(r.cwd), model: str(r.model),
        program: str(r.program), prompt: str(r.prompt), error: str(r.error), resumeId: str(r.resumeId),
        teammateId: str(r.teammateId), teammateName: str(r.teammateName),
      };
    })
    .slice(-MAX_RUN_RECORDS);
}

/** Milliseconds a run has been (or was) live; undefined when unknowable. */
export function runDuration(run: RunRecord, now: number): number | undefined {
  if (run.outcome === "running") return Math.max(0, now - run.startedAt);
  if (run.endedAt === undefined) return undefined;
  return Math.max(0, run.endedAt - run.startedAt);
}

/** Compact duration: "2h 4m", "3m 12s", "17s", "<1s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Relative "when": "just now", "5m ago", "3h ago", "2d ago", else a date. */
export function formatWhen(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Per-agent rollup driving the Usage page cards. */
export interface AgentUsage {
  agentId: string;
  name: string;
  /** Present only while the agent is still in the catalog. */
  program?: string;
  accent?: string;
  /** True when history references an agent since deleted from the catalog. */
  removed: boolean;
  runs: number;
  /** Running right now. */
  live: number;
  taskRuns: number;
  manualRuns: number;
  /** Exit code 0. */
  ok: number;
  /** Nonzero exit code. */
  failed: number;
  stopped: number;
  interrupted: number;
  /** Total session time, including live runs' time so far. */
  totalMs: number;
  /** When the agent was last seen active (now, for a live run). */
  lastActive?: number;
}

/**
 * Roll runs up per agent. Every catalog agent gets a row (zeroed when unused,
 * in catalog order); agents that only exist in history are appended after,
 * flagged `removed`, under their snapshotted name.
 */
export function aggregateUsage(
  runs: RunRecord[],
  agents: { id: string; name: string; program: string; accent: string }[],
  now: number,
): AgentUsage[] {
  const zero = (agentId: string, name: string): AgentUsage => ({
    agentId,
    name,
    removed: true,
    runs: 0,
    live: 0,
    taskRuns: 0,
    manualRuns: 0,
    ok: 0,
    failed: 0,
    stopped: 0,
    interrupted: 0,
    totalMs: 0,
  });
  const map = new Map<string, AgentUsage>();
  for (const a of agents) {
    map.set(a.id, {
      ...zero(a.id, a.name),
      program: a.program,
      accent: a.accent,
      removed: false,
    });
  }
  for (const r of runs) {
    let u = map.get(r.agentId);
    if (!u) {
      u = zero(r.agentId, r.agentName);
      map.set(r.agentId, u);
    }
    u.runs += 1;
    if (r.outcome === "running") u.live += 1;
    if (r.taskId) u.taskRuns += 1;
    else u.manualRuns += 1;
    if (r.outcome === "completed") {
      if (r.exitCode === 0) u.ok += 1;
      else if (r.exitCode !== undefined) u.failed += 1;
    } else if (r.outcome === "failed") u.failed += 1;
    else if (r.outcome === "stopped") u.stopped += 1;
    else if (r.outcome === "interrupted") u.interrupted += 1;
    const d = runDuration(r, now);
    if (d !== undefined) u.totalMs += d;
    const seen = r.outcome === "running" ? now : (r.endedAt ?? r.startedAt);
    if (u.lastActive === undefined || seen > u.lastActive) u.lastActive = seen;
  }
  return [...map.values()];
}
