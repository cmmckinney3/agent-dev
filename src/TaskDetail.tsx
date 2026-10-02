import { useRef, useState } from "react";
import Modal from "./Modal";
import RunReview from "./RunReview";
import { AgentConfig } from "./agents";
import { changeRequestFrom, pickReviewer, VERDICT_LABELS } from "./review";
import { Task } from "./tasks";
import { Teammate } from "./teammates";
import { RunRecord } from "./usage";
import { taskBlocker } from "./workspace";
import { PlayIcon, PencilIcon } from "./icons";
export default function TaskDetail({
  task,
  tasks,
  runs,
  agents,
  reviews,
  reviewedTask,
  onClose,
  onEdit,
  onRun,
  onReview,
  onRequestReview,
  onRequestChanges,
  onOpenTask,
  teammate,
  onOpenTeammate,
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
  /** Enabled agents a review can be assigned to. */
  agents: AgentConfig[];
  /** Live agent-review tasks of this task. */
  reviews: Task[];
  /** The task this one reviews, when it is an agent-review task. */
  reviewedTask?: Task;
  onClose: () => void;
  onEdit: () => void;
  onRun: () => void;
  onReview: () => void;
  onRequestReview: (agentId: string) => void;
  onRequestChanges: (feedback: string, rerun: boolean) => void;
  onOpenTask: (id: string) => void;
  /** The teammate doing this task, if one is. */
  teammate?: Teammate;
  onOpenTeammate: (id: string) => void;
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
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [reviewerId, setReviewerId] = useState("");
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  // The newest review that produced a verdict; its findings can become the
  // next change request.
  const latestVerdict = [...reviews].reverse().find((r) => r.verdict)?.verdict;
  const useFindings = () => {
    if (!latestVerdict) return;
    setFeedback(
      changeRequestFrom(
        changing ? feedback : task.changeRequest,
        latestVerdict,
      ),
    );
    setChanging(true);
    requestAnimationFrame(() => feedbackRef.current?.focus());
  };
  const run = runs.find((r) => r.id === selected) ?? runs[runs.length - 1];
  const blocker = taskBlocker(task, tasks);
  const reviewer = agents.some((a) => a.id === reviewerId)
    ? reviewerId
    : pickReviewer(agents, task.agentId);
  // A task in Review or Done has run even when history recording was off or its
  // records were pruned; the reviewer then inspects the working tree itself.
  const reviewBlock = task.paneId
    ? "Wait for the current run to finish"
    : runs.length === 0 && task.status === "backlog"
      ? "Run the task first"
      : undefined;
  const sendChanges = (rerun: boolean) => {
    onRequestChanges(feedback, rerun);
    setChanging(false);
  };
  return (
    <Modal title={task.title} onClose={onClose} wide>
      <div className="detail-body">
        <div className="detail-actions">
          <span className={`outcome ${task.status}`}>{task.status}</span>
          <span className="muted">
            {task.mode === "headless" ? "Run to completion" : "Interactive"} ·{" "}
            {task.priority ?? "normal"} priority
          </span>
          {teammate && (
            <button
              className="text-button"
              onClick={() => onOpenTeammate(teammate.id)}
              title="Open this teammate's brief and memory"
            >
              Teammate: {teammate.name}
            </button>
          )}
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
            {task.reviewOf && reviewedTask && (
              <div className="detail-actions">
                <span className="muted">
                  Agent review of “{reviewedTask.title}”
                </span>
                <button
                  className="text-button"
                  onClick={() => onOpenTask(reviewedTask.id)}
                >
                  Open reviewed task
                </button>
              </div>
            )}
            {task.reviewOf && task.verdict && (
              <>
                <h3>Verdict</h3>
                <div className="detail-actions">
                  <span className={`outcome verdict-${task.verdict.decision}`}>
                    {VERDICT_LABELS[task.verdict.decision]}
                  </span>
                  <span className="muted">
                    Read from the reviewer's output ·{" "}
                    {new Date(task.verdict.at).toLocaleString()}
                  </span>
                </div>
                {task.verdict.summary && (
                  <pre className="request-view">{task.verdict.summary}</pre>
                )}
              </>
            )}
            <h3>Request</h3>
            <pre className="request-view">{task.prompt}</pre>
            {task.changeRequest && (
              <>
                <h3>Pending change request</h3>
                <pre className="request-view">{task.changeRequest}</pre>
                <div className="detail-actions">
                  <span className="muted">
                    Sent with every run, after the original request, until the
                    task is marked done.
                  </span>
                  <button
                    className="text-button"
                    disabled={Boolean(task.paneId)}
                    onClick={() => onUpdate({ changeRequest: undefined })}
                  >
                    Clear
                  </button>
                </div>
              </>
            )}
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
                aria-expanded={changing}
                onClick={() => {
                  if (!changing) setFeedback(task.changeRequest ?? "");
                  setChanging(!changing);
                }}
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
            {changing && (
              <>
                <label className="review-notes">
                  What needs to change?
                  <textarea
                    ref={feedbackRef}
                    rows={4}
                    autoFocus
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="Specific changes for the next run. The agent receives them after the original request."
                  />
                </label>
                <div className="detail-actions">
                  <button
                    className="btn primary"
                    disabled={Boolean(task.paneId)}
                    onClick={() => sendChanges(true)}
                  >
                    Send back and re-run
                  </button>
                  <button
                    className="btn"
                    disabled={Boolean(task.paneId)}
                    onClick={() => sendChanges(false)}
                  >
                    Send back to backlog
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setChanging(false)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
            {task.reviewedAt && (
              <p className="muted">
                Reviewed {new Date(task.reviewedAt).toLocaleString()}
              </p>
            )}
            {!task.reviewOf && (
              <>
                <h3>Agent review</h3>
                <p className="muted">
                  A second agent runs headless in the same folder, reads the
                  changes, and reports findings without editing files.
                </p>
                {agents.length ? (
                  <div className="detail-actions">
                    <label className="attempt-picker">
                      Reviewer
                      <select
                        value={reviewer ?? ""}
                        onChange={(e) => setReviewerId(e.target.value)}
                      >
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.id === task.agentId
                              ? `${a.name} (same agent)`
                              : a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="btn"
                      disabled={Boolean(reviewBlock) || !reviewer}
                      title={reviewBlock}
                      onClick={() => reviewer && onRequestReview(reviewer)}
                    >
                      Ask for review
                    </button>
                  </div>
                ) : (
                  <p className="muted">
                    Enable an agent in Settings to request a review.
                  </p>
                )}
                {reviews.length > 0 && (
                  <ul className="review-links">
                    {reviews.map((r) => (
                      <li key={r.id}>
                        <span className={`outcome ${r.status}`}>
                          {r.status}
                        </span>
                        {r.verdict && (
                          <span
                            className={`outcome verdict-${r.verdict.decision}`}
                          >
                            {VERDICT_LABELS[r.verdict.decision]}
                          </span>
                        )}
                        {r.lastExitCode !== undefined && (
                          <span className="muted">
                            {r.lastExitCode === 0
                              ? "ok"
                              : `exit ${r.lastExitCode}`}
                          </span>
                        )}
                        <button
                          className="text-button"
                          onClick={() => onOpenTask(r.id)}
                        >
                          {r.title}
                        </button>
                        {r.createdAt !== undefined && (
                          <time className="muted">
                            {new Date(r.createdAt).toLocaleString()}
                          </time>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {latestVerdict && (
                  <div className="verdict-block">
                    <div className="detail-actions">
                      <span
                        className={`outcome verdict-${latestVerdict.decision}`}
                      >
                        {VERDICT_LABELS[latestVerdict.decision]}
                      </span>
                      <span className="muted">
                        Latest agent review findings
                      </span>
                      <span className="spacer" />
                      {latestVerdict.decision === "changes" && (
                        <button
                          className="btn"
                          disabled={
                            Boolean(task.paneId) || !latestVerdict.summary
                          }
                          title={
                            latestVerdict.summary
                              ? "Open Request changes with these findings to edit and send"
                              : "The reviewer gave no findings to use"
                          }
                          onClick={useFindings}
                        >
                          Use as change request
                        </button>
                      )}
                    </div>
                    {latestVerdict.summary ? (
                      <pre className="request-view">
                        {latestVerdict.summary}
                      </pre>
                    ) : (
                      <p className="muted">The reviewer gave no findings.</p>
                    )}
                  </div>
                )}
              </>
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
