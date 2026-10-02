import { useEffect, useState } from "react";
import {
  Activity,
  ACTIVITY_LABELS,
  ACTIVITY_ORDER,
  ActivityState,
  formatElapsed,
} from "./activity";
import { CloseIcon } from "./icons";

export interface DashboardRow {
  /** Pane id. */
  id: string;
  /** The task it is running, else the session name. */
  title: string;
  agent: string;
  accent: string;
  project: string;
  activity: ActivityState;
}

interface Props {
  /** Over the panes rather than beside them (narrow windows). */
  floating?: boolean;
  rows: DashboardRow[];
  onOpen: (id: string) => void;
  onClose: () => void;
}

/** Oldest first for Needs you (longest waiting on top), newest first otherwise. */
const order = (activity: Activity) => (a: DashboardRow, b: DashboardRow) =>
  activity === "waiting"
    ? a.activity.since - b.activity.since
    : b.activity.since - a.activity.since;

/** Every agent in every project, grouped by what it is doing. */
export default function Dashboard({ floating, rows, onOpen, onClose }: Props) {
  // Elapsed times only need to move on a coarse clock.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  const count = (a: Activity) =>
    rows.filter((r) => r.activity.activity === a).length;
  return (
    <aside
      className={`dashboard ${floating ? "floating" : ""}`}
      id="dashboard-panel"
      aria-labelledby="dashboard-heading"
    >
      <header className="dashboard-header">
        <h2 id="dashboard-heading">Dashboard</h2>
        <button
          className="icon-button"
          aria-label="Close dashboard"
          title="Close dashboard"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="dashboard-tiles">
        {ACTIVITY_ORDER.map((a) => (
          <div key={a} className={`dashboard-tile ${a}`}>
            <strong>{count(a)}</strong>
            <span>{ACTIVITY_LABELS[a]}</span>
          </div>
        ))}
      </div>
      <div className="dashboard-sections">
        {rows.length ? (
          ACTIVITY_ORDER.map((a) => {
            const group = rows
              .filter((r) => r.activity.activity === a)
              .sort(order(a));
            if (!group.length) return null;
            return (
              <section key={a} aria-labelledby={`dashboard-${a}`}>
                <h3 id={`dashboard-${a}`}>
                  {ACTIVITY_LABELS[a]} <span>{group.length}</span>
                </h3>
                <ul>
                  {group.map((r) => {
                    const elapsed = formatElapsed(now - r.activity.since);
                    const state =
                      a === "idle"
                        ? ACTIVITY_LABELS[a]
                        : `${ACTIVITY_LABELS[a]} · ${elapsed}`;
                    return (
                      <li key={r.id}>
                        <button
                          className={`dashboard-row ${a}`}
                          onClick={() => onOpen(r.id)}
                          aria-label={`${r.title}, ${r.agent}, ${r.project}. ${state}${r.activity.reason ? `. ${r.activity.reason}` : ""}`}
                        >
                          <span
                            className="dashboard-mark"
                            style={{ background: r.accent }}
                            aria-hidden="true"
                          />
                          <span className="dashboard-text">
                            <strong>{r.title}</strong>
                            <small>
                              {r.agent} · {r.project}
                            </small>
                            {r.activity.reason && (
                              <small className="dashboard-reason">
                                {r.activity.reason}
                              </small>
                            )}
                          </span>
                          <span className={`dashboard-state ${a}`}>
                            {state}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        ) : (
          <p className="empty-small">
            No agents yet. Start a session or run a task and it shows up here
            with what it is doing.
          </p>
        )}
      </div>
    </aside>
  );
}
