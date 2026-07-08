// Usage page: per-agent run history — how often each catalog agent runs, for
// how long, and how those runs end. Pure presentation over the RunRecord log
// owned by App; recording happens there, aggregation in usage.ts.

import { useEffect, useMemo, useState } from "react";
import { AgentConfig } from "./agents";
import {
  AgentUsage,
  MAX_RUN_RECORDS,
  RunRecord,
  aggregateUsage,
  formatDuration,
  formatWhen,
  runDuration,
} from "./usage";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckIcon,
  KanbanIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from "./icons";
import "./UsagePage.css";

type Range = "24h" | "7d" | "30d" | "all";

const RANGES: { id: Range; label: string; ms?: number; title: string }[] = [
  { id: "24h", label: "24h", ms: 24 * 3_600_000, title: "Last 24 hours" },
  { id: "7d", label: "7d", ms: 7 * 24 * 3_600_000, title: "Last 7 days" },
  { id: "30d", label: "30d", ms: 30 * 24 * 3_600_000, title: "Last 30 days" },
  { id: "all", label: "All", title: "All recorded history" },
];

/** Rows shown in the recent-runs table. */
const RECENT_LIMIT = 50;

function OutcomeBadge({ run }: { run: RunRecord }) {
  switch (run.outcome) {
    case "running":
      return (
        <span className="u-badge live">
          <span className="u-badge-dot" aria-hidden="true" />
          Live
        </span>
      );
    case "stopped":
      return (
        <span className="u-badge stopped">
          <StopIcon width={11} height={11} /> Stopped
        </span>
      );
    case "interrupted":
      return (
        <span
          className="u-badge interrupted"
          title="The app closed while this run was live — its duration is unknown"
        >
          <AlertTriangleIcon width={11} height={11} /> Interrupted
        </span>
      );
    case "completed":
      if (run.exitCode === 0)
        return (
          <span className="u-badge ok">
            <CheckIcon width={11} height={11} /> ok
          </span>
        );
      if (run.exitCode !== undefined)
        return (
          <span className="u-badge failed">
            <AlertTriangleIcon width={11} height={11} /> exit {run.exitCode}
          </span>
        );
      return <span className="u-badge stopped">Exited</span>;
  }
}

function AgentCard({
  usage,
  grandMs,
  now,
}: {
  usage: AgentUsage;
  /** Total session time across all agents in range, for the share meter. */
  grandMs: number;
  now: number;
}) {
  const u = usage;
  // Interrupted runs have no known duration, so they can't feed the average.
  const timed = u.runs - u.interrupted;
  const share = grandMs > 0 ? Math.round((u.totalMs / grandMs) * 100) : 0;
  return (
    <article
      className={`u-agent ${u.removed ? "removed" : ""}`}
      style={
        {
          "--agent-accent": u.accent ?? "var(--text-dim)",
        } as React.CSSProperties
      }
    >
      <header className="u-agent-head">
        <span className="u-agent-dot" aria-hidden="true" />
        <span className="u-agent-name">{u.name}</span>
        {u.program && <code className="u-agent-prog">{u.program}</code>}
        {u.removed && (
          <span
            className="u-agent-removed"
            title="No longer in the agent catalog — history kept"
          >
            removed
          </span>
        )}
        {u.live > 0 && (
          <span className="u-agent-live">
            <span className="u-badge-dot" aria-hidden="true" />
            {u.live} live
          </span>
        )}
      </header>

      <dl className="u-agent-stats">
        <div className="u-stat">
          <dt>Runs</dt>
          <dd>{u.runs}</dd>
        </div>
        <div className="u-stat">
          <dt>Session time</dt>
          <dd>{u.totalMs > 0 ? formatDuration(u.totalMs) : "—"}</dd>
        </div>
        <div className="u-stat">
          <dt>Avg run</dt>
          <dd>{timed > 0 ? formatDuration(u.totalMs / timed) : "—"}</dd>
        </div>
        <div className="u-stat">
          <dt>Last active</dt>
          <dd>
            {u.live > 0
              ? "now"
              : u.lastActive !== undefined
                ? formatWhen(u.lastActive, now)
                : "—"}
          </dd>
        </div>
      </dl>

      {u.runs > 0 && (
        <div className="u-agent-chips">
          <span className="u-chip" title="Runs launched from task cards">
            <KanbanIcon width={11} height={11} /> {u.taskRuns} task
          </span>
          <span className="u-chip" title="Runs started by hand in a pane">
            <TerminalIcon width={11} height={11} /> {u.manualRuns} manual
          </span>
          {u.ok > 0 && (
            <span className="u-chip ok" title="Exited with code 0">
              <CheckIcon width={11} height={11} /> {u.ok} ok
            </span>
          )}
          {u.failed > 0 && (
            <span className="u-chip failed" title="Exited with a nonzero code">
              <AlertTriangleIcon width={11} height={11} /> {u.failed} failed
            </span>
          )}
          {u.stopped > 0 && (
            <span className="u-chip" title="Stopped from the app">
              <StopIcon width={11} height={11} /> {u.stopped} stopped
            </span>
          )}
          {u.interrupted > 0 && (
            <span
              className="u-chip interrupted"
              title="The app closed while these ran — durations unknown"
            >
              <AlertTriangleIcon width={11} height={11} /> {u.interrupted}{" "}
              interrupted
            </span>
          )}
        </div>
      )}

      {grandMs > 0 && u.totalMs > 0 && (
        <div
          className="u-meter"
          title={`${u.name}: ${share}% of all session time in this range`}
        >
          <span className="u-meter-track" aria-hidden="true">
            <span
              className="u-meter-fill"
              style={{ width: `${Math.max(share, 1.5)}%` }}
            />
          </span>
          <span className="u-meter-val">{share}% of session time</span>
        </div>
      )}
    </article>
  );
}

export default function UsagePage({
  runs,
  agents,
  onClear,
}: {
  runs: RunRecord[];
  /** Current catalog — every agent gets a card, even before its first run. */
  agents: AgentConfig[];
  /** Clears finished history (live runs stay so they can still close). */
  onClear: () => void;
}) {
  const [range, setRange] = useState<Range>("all");
  const [now, setNow] = useState(() => Date.now());

  // Tick once a second while anything is live so durations count up.
  const anyLive = runs.some((r) => r.outcome === "running");
  useEffect(() => {
    setNow(Date.now());
    if (!anyLive) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyLive, runs, range]);

  const rangeMs = RANGES.find((r) => r.id === range)?.ms;
  const cutoff = rangeMs === undefined ? 0 : now - rangeMs;
  // Live runs always count as "in range" — they are happening now.
  const visible = useMemo(
    () =>
      runs.filter((r) => r.outcome === "running" || r.startedAt >= cutoff),
    [runs, cutoff],
  );

  const perAgent = useMemo(() => {
    const rows = aggregateUsage(visible, agents, now);
    // Most-used first; ties keep catalog order (stable sort), zeroes sink.
    return rows.sort((a, b) => b.runs - a.runs);
  }, [visible, agents, now]);

  const liveCount = visible.filter((r) => r.outcome === "running").length;
  const grandMs = perAgent.reduce((sum, u) => sum + u.totalMs, 0);
  const usedCount = perAgent.filter((u) => u.runs > 0).length;
  const recent = useMemo(
    () =>
      [...visible]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, RECENT_LIMIT),
    [visible],
  );

  const hasClearable = runs.some((r) => r.outcome !== "running");
  const rangeTitle = RANGES.find((r) => r.id === range)?.title ?? "";

  return (
    <section className="usage-page" aria-label="Agent usage">
      <div className="usage-inner">
        <header className="usage-head">
          <div className="usage-lead">
            <h1 className="usage-title">
              <ActivityIcon width={17} height={17} /> Usage
            </h1>
            <p className="usage-sub">
              Runs, session time, and outcomes per agent. Recorded locally with
              the workspace — the last {MAX_RUN_RECORDS} runs are kept.
            </p>
          </div>
          <div className="usage-range" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`u-range-btn ${range === r.id ? "on" : ""}`}
                aria-pressed={range === r.id}
                title={r.title}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn"
            disabled={!hasClearable}
            title={
              hasClearable
                ? "Delete all finished run records (live runs stay)"
                : "Nothing to clear yet"
            }
            onClick={onClear}
          >
            <TrashIcon /> Clear history
          </button>
        </header>

        {runs.length === 0 ? (
          <div className="usage-empty">
            <ActivityIcon width={26} height={26} />
            <p>
              <b>No usage recorded yet</b>
              <br />
              Start an agent in the Workspace — every run lands here
              automatically.
            </p>
          </div>
        ) : (
          <>
            <div className="usage-tiles">
              <div className="u-tile">
                <span className="u-tile-label">Runs</span>
                <span className="u-tile-value">{visible.length}</span>
              </div>
              <div className="u-tile">
                <span className="u-tile-label">Session time</span>
                <span className="u-tile-value">
                  {grandMs > 0 ? formatDuration(grandMs) : "—"}
                </span>
              </div>
              <div className="u-tile">
                <span className="u-tile-label">Active now</span>
                <span className={`u-tile-value ${liveCount > 0 ? "live" : ""}`}>
                  {liveCount}
                </span>
              </div>
              <div className="u-tile">
                <span className="u-tile-label">Agents used</span>
                <span className="u-tile-value">
                  {usedCount}
                  <span className="u-tile-of"> of {agents.length}</span>
                </span>
              </div>
            </div>

            <h2 className="usage-section">Per agent</h2>
            <div className="usage-grid">
              {perAgent.map((u) => (
                <AgentCard
                  key={u.agentId}
                  usage={u}
                  grandMs={grandMs}
                  now={now}
                />
              ))}
            </div>

            <h2 className="usage-section">Recent runs</h2>
            {recent.length === 0 ? (
              <p className="usage-none">
                No runs in this range ({rangeTitle.toLowerCase()}) — widen it to
                see older history.
              </p>
            ) : (
              <div className="u-table-wrap">
                <table className="u-table">
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col">Session</th>
                      <th scope="col">Origin</th>
                      <th scope="col">Started</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r) => {
                      const accent = agents.find(
                        (a) => a.id === r.agentId,
                      )?.accent;
                      const dur = runDuration(r, now);
                      return (
                        <tr key={r.id}>
                          <td>
                            <span
                              className="u-row-agent"
                              style={
                                {
                                  "--agent-accent":
                                    accent ?? "var(--text-dim)",
                                } as React.CSSProperties
                              }
                            >
                              <span
                                className="u-agent-dot"
                                aria-hidden="true"
                              />
                              {r.agentName}
                            </span>
                          </td>
                          <td className="u-cell-dim">{r.session || "—"}</td>
                          <td>
                            {r.taskId ? (
                              <span
                                className="u-row-task"
                                title={`Task${r.mode ? ` (${r.mode})` : ""}: ${r.taskTitle ?? r.taskId}`}
                              >
                                <KanbanIcon width={11} height={11} />
                                <span className="u-row-task-text">
                                  {r.taskTitle ?? r.taskId}
                                </span>
                              </span>
                            ) : (
                              <span className="u-cell-dim">Manual</span>
                            )}
                          </td>
                          <td
                            className="u-cell-dim"
                            title={new Date(r.startedAt).toLocaleString()}
                          >
                            {formatWhen(r.startedAt, now)}
                          </td>
                          <td className="u-cell-num">
                            {dur !== undefined ? formatDuration(dur) : "—"}
                          </td>
                          <td>
                            <OutcomeBadge run={r} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
