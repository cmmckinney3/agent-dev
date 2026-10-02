import { useState } from "react";
import { AgentConfig } from "./agents";
import { Teammate } from "./teammates";
import { Task, TASK_COLUMNS, TaskStatus } from "./tasks";
import { taskBlocker } from "./workspace";
import {
  PlusIcon,
  SearchIcon,
  KanbanIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlayIcon,
  StopIcon,
  ChevronUpIcon,
  PanelLeftIcon,
} from "./icons";
interface Props {
  tasks: Task[];
  allTasks: Task[];
  agents: AgentConfig[];
  teammates: Teammate[];
  collapsed: boolean;
  onCollapse: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRun: (id: string) => void;
  onMove: (id: string, status: TaskStatus) => void;
  onCancelQueue: (id: string) => void;
  onReorder: (id: string, direction: number) => void;
}
export default function TaskBoard(p: Props) {
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("");
  const [archive, setArchive] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>(["done"]);
  const shown = p.tasks.filter(
    (t) =>
      Boolean(t.archived) === archive &&
      (!agent || t.agentId === agent) &&
      `${t.title} ${t.prompt}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (p.collapsed)
    return (
      <aside className="task-rail collapsed">
        <button
          className="icon-button"
          aria-label="Expand tasks"
          title="Expand tasks"
          onClick={p.onCollapse}
        >
          <KanbanIcon />
        </button>
        {TASK_COLUMNS.map((c) => (
          <span
            key={c.id}
            title={`${c.label}: ${p.tasks.filter((t) => t.status === c.id && !t.archived).length}`}
          >
            {p.tasks.filter((t) => t.status === c.id && !t.archived).length}
          </span>
        ))}
        <button className="icon-button" aria-label="New task" onClick={p.onNew}>
          <PlusIcon />
        </button>
      </aside>
    );
  return (
    <aside className="task-rail">
      <header className="rail-head">
        <span>
          <KanbanIcon />
          Tasks <small>{p.tasks.filter((t) => !t.archived).length}</small>
        </span>
        <button
          className="icon-button"
          aria-label="New task"
          title="New task (Ctrl+Shift+N)"
          onClick={p.onNew}
        >
          <PlusIcon />
        </button>
        <button
          className="icon-button"
          aria-label="Collapse tasks"
          onClick={p.onCollapse}
        >
          <PanelLeftIcon />
        </button>
      </header>
      <div className="rail-tools">
        <label className="search-field">
          <SearchIcon />
          <input
            aria-label="Search tasks"
            placeholder="Search tasks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="rail-filters">
          <select
            aria-label="Filter tasks by agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          >
            <option value="">All agents</option>
            {p.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            className={archive ? "chip selected" : "chip"}
            aria-pressed={archive}
            onClick={() => setArchive(!archive)}
          >
            Archived
          </button>
        </div>
      </div>
      <div className="task-groups">
        {p.tasks.length === 0 ? (
          <div className="rail-empty">
            <KanbanIcon />
            <h3>Your next idea starts here</h3>
            <p>
              Create a task, choose an agent, and follow the result through
              review.
            </p>
            <button className="btn primary" onClick={p.onNew}>
              <PlusIcon />
              Create first task
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className="empty-small">No tasks match these filters.</p>
        ) : (
          TASK_COLUMNS.map((column) => {
            const cards = shown.filter((t) => t.status === column.id);
            const closed = collapsed.includes(column.id) && !query;
            return (
              <section
                key={column.id}
                className="task-group"
                onDragOver={(e) => {
                  if (
                    e.dataTransfer.types.includes("application/x-crucible-task")
                  )
                    e.preventDefault();
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(
                    "application/x-crucible-task",
                  );
                  if (id) {
                    e.preventDefault();
                    p.onMove(id, column.id);
                  }
                }}
              >
                <button
                  className="group-toggle"
                  aria-expanded={!closed}
                  onClick={() =>
                    setCollapsed((prev) =>
                      closed
                        ? prev.filter((c) => c !== column.id)
                        : [...prev, column.id],
                    )
                  }
                >
                  {closed ? <ChevronRightIcon /> : <ChevronDownIcon />}
                  <span>{column.label}</span>
                  <small>{cards.length}</small>
                </button>
                {!closed && (
                  <div className="task-group-cards">
                    {cards.length === 0 ? (
                      <div className="task-drop-hint">
                        {column.id === "running"
                          ? "Drop a task here to run"
                          : "No tasks"}
                      </div>
                    ) : (
                      cards.map((task) => {
                        const a = p.agents.find((a) => a.id === task.agentId);
                        const mate = task.teammateId
                          ? p.teammates.find((t) => t.id === task.teammateId)
                          : undefined;
                        const blocker = taskBlocker(task, p.allTasks);
                        return (
                          <article
                            className={`task-item ${task.queued ? "queued" : ""}`}
                            key={task.id}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData(
                                "application/x-crucible-task",
                                task.id,
                              );
                              e.dataTransfer.effectAllowed = "move";
                            }}
                          >
                            <div className="task-item-meta">
                              <span style={{ color: a?.accent }}>
                                {mate?.name ?? a?.name ?? "Agent"}
                              </span>
                              {task.priority === "high" && (
                                <span className="priority-high">High</span>
                              )}
                              {task.isolation && <span>Worktree</span>}
                              {task.reviewOf && (
                                <span
                                  className={
                                    task.verdict
                                      ? `verdict-chip ${task.verdict.decision}`
                                      : undefined
                                  }
                                >
                                  {task.verdict
                                    ? `Review · ${task.verdict.decision === "approve" ? "Approved" : "Changes"}`
                                    : "Review"}
                                </span>
                              )}
                              {task.changeRequest && <span>Changes</span>}
                            </div>
                            <button
                              className="task-title-link"
                              onClick={() => p.onOpen(task.id)}
                            >
                              {task.title}
                            </button>
                            <p className="task-excerpt">{task.prompt}</p>
                            {(task.attention ||
                              task.interrupted ||
                              task.queued ||
                              blocker) && (
                              <p className="task-attention">
                                {task.attention ||
                                  (task.interrupted
                                    ? "Interrupted · previous output saved"
                                    : blocker ||
                                      "Queued · waiting for a session")}
                              </p>
                            )}
                            <div className="task-item-actions">
                              <select
                                aria-label={`Status of ${task.title}`}
                                value={task.status}
                                onChange={(e) =>
                                  p.onMove(
                                    task.id,
                                    e.target.value as TaskStatus,
                                  )
                                }
                              >
                                {TASK_COLUMNS.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.label}
                                  </option>
                                ))}
                              </select>
                              {task.queued ? (
                                <>
                                  <button
                                    className="icon-button"
                                    title="Move earlier in queue"
                                    aria-label={`Move ${task.title} earlier`}
                                    onClick={() => p.onReorder(task.id, -1)}
                                  >
                                    <ChevronUpIcon />
                                  </button>
                                  <button
                                    className="icon-button"
                                    title="Move later in queue"
                                    aria-label={`Move ${task.title} later`}
                                    onClick={() => p.onReorder(task.id, 1)}
                                  >
                                    <ChevronDownIcon />
                                  </button>
                                  <button
                                    className="icon-button"
                                    title="Cancel queue"
                                    aria-label={`Cancel queue for ${task.title}`}
                                    onClick={() => p.onCancelQueue(task.id)}
                                  >
                                    <StopIcon />
                                  </button>
                                </>
                              ) : task.paneId ? (
                                <button
                                  className="text-button"
                                  onClick={() => p.onOpen(task.id)}
                                >
                                  Open
                                </button>
                              ) : (
                                !archive && (
                                  <button
                                    className="text-button"
                                    title={
                                      blocker
                                        ? `${blocker}. Queue it to start automatically.`
                                        : undefined
                                    }
                                    onClick={() => p.onRun(task.id)}
                                  >
                                    <PlayIcon />
                                    {blocker ? "Queue" : "Run"}
                                  </button>
                                )
                              )}
                            </div>
                          </article>
                        );
                      })
                    )}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}
