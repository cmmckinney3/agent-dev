import { useState } from "react";
import Modal from "./Modal";
import RunReview from "./RunReview";
import { Task } from "./tasks";
import { RunRecord } from "./usage";
import { taskBlocker } from "./workspace";
import { PlayIcon, PencilIcon } from "./icons";
export default function TaskDetail({
  task,
  tasks,
  runs,
  onClose,
  onEdit,
  onRun,
  onReview,
  onArchive,
  onDuplicate,
  onFocus,
  onUpdate,
  onRunUpdate,
  onResume,
}: {
  task: Task;
  tasks: Task[];
  runs: RunRecord[];
  onClose: () => void;
  onEdit: () => void;
  onRun: () => void;
  onReview: () => void;
  onArchive: () => void;
  onDuplicate: () => void;
  onFocus: () => void;
  onUpdate: (patch: Partial<Task>) => void;
  onRunUpdate: (id: string, patch: Partial<RunRecord>) => void;
  onResume?: (run: RunRecord, id: string) => void;
}) {
  const [selected, setSelected] = useState(runs[runs.length - 1]?.id ?? "");
  const [notes, setNotes] = useState(task.reviewNotes ?? "");
  const [tab, setTab] = useState<"overview" | "runs">("overview");
  const run = runs.find((r) => r.id === selected) ?? runs[runs.length - 1];
  const blocker = taskBlocker(task, tasks);
  return (
    <Modal title={task.title} onClose={onClose} wide>
      <div className="detail-body">
        <div className="detail-actions">
          <span className={`outcome ${task.status}`}>{task.status}</span>
          <span className="muted">
            {task.mode === "headless" ? "Run to completion" : "Interactive"} ·{" "}
            {task.priority ?? "normal"} priority
          </span>
          <span className="spacer" />
          {task.paneId ? (
            <button className="btn" onClick={onFocus}>
              Focus session
            </button>
          ) : (
            <button
              className="btn"
              title={
                blocker
                  ? `${blocker}. Queue it to start automatically.`
                  : undefined
              }
              onClick={onRun}
            >
              <PlayIcon />
              {blocker ? "Queue task" : "Run task"}
            </button>
          )}
          <button
            className="btn"
            disabled={Boolean(task.paneId)}
            onClick={onEdit}
          >
            <PencilIcon />
            Edit
          </button>
        </div>
        {(task.attention || blocker || task.interrupted) && (
          <p className="notice-inline">
            {task.attention ||
              blocker ||
              "This task was interrupted. Review its saved output or start a new run."}
          </p>
        )}
        <div className="review-tabs" role="tablist" aria-label="Task details">
          <button
            role="tab"
            aria-selected={tab === "overview"}
            onClick={() => setTab("overview")}
          >
            Overview & review
          </button>
          <button
            role="tab"
            aria-selected={tab === "runs"}
            onClick={() => setTab("runs")}
          >
            Run attempts ({runs.length})
          </button>
        </div>
        {tab === "overview" ? (
          <>
            <h3>Request</h3>
            <pre className="request-view">{task.prompt}</pre>
            {task.worktree && (
              <p className="muted">Isolated worktree: {task.worktree}</p>
            )}
            <label className="review-notes">
              Review notes
              <textarea
                rows={4}
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  onUpdate({ reviewNotes: e.target.value });
                }}
                onBlur={() => onUpdate({ reviewNotes: notes })}
                placeholder="What changed? Which checks passed? What still needs work?"
              />
            </label>
            <div className="detail-actions">
              <button
                className="btn primary"
                disabled={Boolean(task.paneId)}
                onClick={() => {
                  onUpdate({ reviewNotes: notes });
                  onReview();
                }}
              >
                Mark reviewed & done
              </button>
              <button
                className="btn"
                onClick={() =>
                  onUpdate({
                    attention: "Changes requested",
                    status: "backlog",
                    reviewedAt: undefined,
                  })
                }
                disabled={Boolean(task.paneId)}
              >
                Request changes
              </button>
              <button
                className="text-button"
                onClick={() =>
                  onUpdate({
                    attention: task.attention ? undefined : "Needs your input",
                  })
                }
              >
                {task.attention ? "Clear attention" : "Mark needs input"}
              </button>
            </div>
            {task.reviewedAt && (
              <p className="muted">
                Reviewed {new Date(task.reviewedAt).toLocaleString()}
              </p>
            )}
          </>
        ) : (
          <>
            {runs.length === 0 ? (
              <p className="empty-small">
                No attempts yet. The original request and every future run will
                be kept here.
              </p>
            ) : (
              <>
                <label className="attempt-picker">
                  Run attempt
                  <select
                    value={run?.id}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {[...runs].reverse().map((r, i) => (
                      <option key={r.id} value={r.id}>
                        Attempt {runs.length - i} · {r.outcome} ·{" "}
                        {new Date(r.startedAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
                {run && (
                  <RunReview
                    key={run.id}
                    run={run}
                    onRerun={!task.paneId ? onRun : undefined}
                    onResume={
                      onResume &&
                      (run.program === "codex" || run.program === "claude")
                        ? (id) => onResume(run, id)
                        : undefined
                    }
                    onUpdate={(patch) => onRunUpdate(run.id, patch)}
                  />
                )}
              </>
            )}
          </>
        )}
        <footer className="dialog-actions">
          <button className="text-button" onClick={onDuplicate}>
            Duplicate task
          </button>
          <button
            className="text-button"
            disabled={Boolean(task.paneId)}
            onClick={onArchive}
          >
            {task.archived ? "Restore task" : "Archive task"}
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </Modal>
  );
}
