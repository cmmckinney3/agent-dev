import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  COLUMN_ORDER,
  Task,
  TaskDraft,
  TaskMode,
  TASK_COLUMNS,
  TaskStatus,
} from "./tasks";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CrosshairIcon,
  FolderIcon,
  KanbanIcon,
  PanelLeftIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RestartIcon,
  TrashIcon,
} from "./icons";
import "./TaskBoard.css";

interface AgentOption {
  id: string;
  name: string;
  accent: string;
}

interface TaskBoardProps {
  tasks: Task[];
  /** Agent catalog — drives the composer select and per-card accent. */
  agents: AgentOption[];
  /** Shared default cwd, shown as the inherited dir in the composer. */
  defaultCwd: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onAdd: (draft: TaskDraft) => void;
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  /** Column move (DnD + ◀ ▶). Moving into Running launches the task. */
  onMove: (id: string, status: TaskStatus) => void;
  /** Explicit launch / re-launch into a free pane. */
  onRun: (id: string) => void;
  onFocusPane: (paneId: string) => void;
  /** Count of tasks reset Running→Backlog on load; shows a one-time notice. */
  resetNotice: number;
  onDismissReset: () => void;
}

/** Last path segment, for a compact directory label. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export default function TaskBoard({
  tasks,
  agents,
  defaultCwd,
  collapsed,
  onToggleCollapsed,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
  onRun,
  onFocusPane,
  resetNotice,
  onDismissReset,
}: TaskBoardProps) {
  const agentById = (id: string) => agents.find((a) => a.id === id) ?? agents[0];

  // ---- Drag-and-drop ----
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null);

  // ---- Composer ----
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [mode, setMode] = useState<TaskMode>("interactive");
  const [dir, setDir] = useState("");
  const titleRef = useRef<HTMLInputElement | null>(null);

  // Move focus to the title field whenever the composer opens.
  useEffect(() => {
    if (composerOpen) titleRef.current?.focus();
  }, [composerOpen]);

  const resetComposer = () => {
    setEditingId(null);
    setTitle("");
    setPrompt("");
    setAgentId(agents[0]?.id ?? "");
    setMode("interactive");
    setDir("");
  };

  const openComposer = () => {
    resetComposer();
    setComposerOpen(true);
  };

  const editTask = (t: Task) => {
    setEditingId(t.id);
    setTitle(t.title);
    setPrompt(t.prompt);
    setAgentId(t.agentId);
    setMode(t.mode);
    setDir(t.cwd ?? "");
    setComposerOpen(true);
  };

  const closeComposer = () => {
    setComposerOpen(false);
    resetComposer();
  };

  const submit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return; // a task needs a prompt to seed the agent
    const draft: TaskDraft = {
      title: title.trim() || "Untitled task",
      prompt: trimmed,
      agentId,
      mode,
      cwd: dir.trim() || undefined,
    };
    if (editingId) onUpdate(editingId, draft);
    else onAdd(draft);
    closeComposer();
  };

  const browseDir = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Working directory for this task",
    });
    if (typeof picked === "string") setDir(picked);
  };

  // ---- Render: collapsed icon strip ----
  if (collapsed) {
    return (
      <aside className="board collapsed">
        <button
          className="strip-toggle"
          onClick={onToggleCollapsed}
          aria-label="Expand task board"
          title="Expand task board"
        >
          <KanbanIcon width={18} height={18} />
        </button>
        <div className="strip-counts">
          {TASK_COLUMNS.map((col) => {
            const n = tasks.filter((t) => t.status === col.id).length;
            return (
              <span
                key={col.id}
                className={`strip-count ${col.id}`}
                title={`${col.label}: ${n}`}
              >
                <span className="strip-count-dot" />
                {n}
              </span>
            );
          })}
        </div>
        <button
          className="strip-new"
          onClick={() => {
            onToggleCollapsed();
            openComposer();
          }}
          aria-label="New task"
          title="New task"
        >
          <PlusIcon width={16} height={16} />
        </button>
      </aside>
    );
  }

  // ---- Render: expanded board ----
  return (
    <aside className="board">
      <header className="board-head">
        <span className="board-title">
          <KanbanIcon width={16} height={16} /> Tasks
        </span>
        <span className="board-count">{tasks.length}</span>
        <span className="board-head-spacer" />
        <button
          className="board-new"
          onClick={openComposer}
          disabled={composerOpen && !editingId}
        >
          <PlusIcon width={14} height={14} /> New
        </button>
        <button
          className="board-collapse"
          onClick={onToggleCollapsed}
          aria-label="Collapse task board"
          title="Collapse task board"
        >
          <PanelLeftIcon width={15} height={15} />
        </button>
      </header>

      {composerOpen && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="composer-head">
            <span>{editingId ? "Edit task" : "New task"}</span>
            <button
              type="button"
              className="composer-x"
              onClick={closeComposer}
              aria-label="Close composer"
            >
              <CloseIcon width={14} height={14} />
            </button>
          </div>
          <input
            ref={titleRef}
            className="composer-title"
            placeholder="Task title"
            aria-label="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            spellCheck={false}
          />
          <textarea
            className="composer-prompt"
            placeholder="Prompt to seed the agent with…"
            aria-label="Task prompt"
            value={prompt}
            rows={3}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter submits from the textarea.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-row">
            <select
              className="composer-select"
              aria-label="Agent for this task"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="composer-mode" role="group" aria-label="Run mode">
              <button
                type="button"
                className={mode === "interactive" ? "on" : ""}
                aria-pressed={mode === "interactive"}
                onClick={() => setMode("interactive")}
                title="Stays running so you can watch and steer"
              >
                Interactive
              </button>
              <button
                type="button"
                className={mode === "headless" ? "on" : ""}
                aria-pressed={mode === "headless"}
                onClick={() => setMode("headless")}
                title="Runs to completion, then auto-advances to Review"
              >
                Headless
              </button>
            </div>
          </div>
          <div className="composer-row">
            <button
              type="button"
              className={`composer-dir ${dir ? "set" : ""}`}
              onClick={browseDir}
              title={
                dir
                  ? `Runs in ${dir}`
                  : defaultCwd
                    ? `Inherits default: ${defaultCwd}`
                    : "Uses the process default directory"
              }
            >
              <FolderIcon width={13} height={13} />
              <span className="composer-dir-text">
                {dir
                  ? baseName(dir)
                  : defaultCwd
                    ? `Inherit · ${baseName(defaultCwd)}`
                    : "Default dir"}
              </span>
            </button>
            {dir && (
              <button
                type="button"
                className="composer-dir-clear"
                onClick={() => setDir("")}
                aria-label="Clear directory override"
                title="Inherit the default directory"
              >
                <CloseIcon width={13} height={13} />
              </button>
            )}
            <span className="composer-row-spacer" />
            <button
              type="button"
              className="composer-cancel"
              onClick={closeComposer}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="composer-save"
              disabled={!prompt.trim()}
            >
              {editingId ? "Save" : "Add task"}
            </button>
          </div>
        </form>
      )}

      <div className="board-cols">
        {resetNotice > 0 && (
          <div className="board-notice" role="status">
            <span>
              {resetNotice} task{resetNotice > 1 ? "s" : ""} reset to Backlog
              after restart — agents don't resume automatically.
            </span>
            <button
              type="button"
              className="board-notice-x"
              onClick={onDismissReset}
              aria-label="Dismiss restart notice"
            >
              <CloseIcon width={13} height={13} />
            </button>
          </div>
        )}
        {TASK_COLUMNS.map((col) => {
          const cards = tasks.filter((t) => t.status === col.id);
          return (
            <section
              key={col.id}
              className={`board-col ${dragOverCol === col.id ? "drag-over" : ""}`}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverCol !== col.id) setDragOverCol(col.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/task-id") || dragId;
                setDragOverCol(null);
                setDragId(null);
                if (id) onMove(id, col.id);
              }}
            >
              <div className="col-head">
                <span className="col-name">{col.label}</span>
                <span className="col-count">{cards.length}</span>
              </div>
              <div className="col-cards">
                {cards.length === 0 ? (
                  <div className="col-empty">
                    {col.id === "backlog"
                      ? "No tasks yet"
                      : col.id === "running"
                        ? "Drop a card here to launch it"
                        : "Empty"}
                  </div>
                ) : (
                  cards.map((task) => {
                    const agent = agentById(task.agentId);
                    const idx = COLUMN_ORDER.indexOf(task.status);
                    return (
                      <article
                        key={task.id}
                        className={`task-card ${
                          dragId === task.id ? "dragging" : ""
                        } ${task.queued ? "queued" : ""}`}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/task-id", task.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDragId(task.id);
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setDragOverCol(null);
                        }}
                        style={
                          {
                            "--card-accent": agent.accent,
                          } as React.CSSProperties
                        }
                      >
                        <div className="card-top">
                          <span className="card-agent" title={agent.name}>
                            <span className="card-agent-dot" />
                            {agent.name}
                          </span>
                          {task.mode === "headless" && (
                            <span
                              className="card-mode"
                              title="Runs headless and auto-advances on completion"
                            >
                              headless
                            </span>
                          )}
                          {task.lastExitCode !== undefined && (
                            <span
                              className={`card-outcome ${
                                task.lastExitCode === 0 ? "ok" : "failed"
                              }`}
                              title={
                                task.lastExitCode === 0
                                  ? "Last run completed cleanly (exit 0)"
                                  : `Last run failed (exit ${task.lastExitCode})`
                              }
                            >
                              {task.lastExitCode === 0 ? (
                                <>
                                  <CheckIcon width={11} height={11} /> ok
                                </>
                              ) : (
                                <>
                                  <AlertTriangleIcon width={11} height={11} />{" "}
                                  exit {task.lastExitCode}
                                </>
                              )}
                            </span>
                          )}
                          <span className="card-top-spacer" />
                          <button
                            className="card-icon-btn"
                            title="Edit task"
                            aria-label={`Edit task: ${task.title}`}
                            onClick={() => editTask(task)}
                          >
                            <PencilIcon width={13} height={13} />
                          </button>
                          <button
                            className="card-icon-btn danger"
                            title="Delete task"
                            aria-label={`Delete task: ${task.title}`}
                            onClick={() => onDelete(task.id)}
                          >
                            <TrashIcon width={13} height={13} />
                          </button>
                        </div>

                        <h3 className="card-title">{task.title}</h3>
                        {task.prompt && (
                          <p className="card-prompt">{task.prompt}</p>
                        )}
                        {task.cwd && (
                          <span className="card-dir" title={task.cwd}>
                            <FolderIcon width={11} height={11} />
                            {baseName(task.cwd)}
                          </span>
                        )}
                        {task.queued && (
                          <p className="card-queued">
                            Waiting for a free pane…
                          </p>
                        )}

                        <div className="card-actions">
                          <button
                            className="card-move"
                            disabled={idx <= 0}
                            aria-label="Move to previous column"
                            title="Move to previous column"
                            onClick={() => onMove(task.id, COLUMN_ORDER[idx - 1])}
                          >
                            <ChevronLeftIcon width={14} height={14} />
                          </button>

                          {task.status === "running" ? (
                            task.paneId ? (
                              <button
                                className="card-primary"
                                onClick={() => onFocusPane(task.paneId!)}
                                title="Focus the pane running this task"
                              >
                                <CrosshairIcon width={13} height={13} /> Focus
                              </button>
                            ) : (
                              <button
                                className="card-primary"
                                onClick={() => onRun(task.id)}
                                title="Re-launch into a free pane"
                              >
                                <RestartIcon width={13} height={13} /> Re-run
                              </button>
                            )
                          ) : task.status === "backlog" ? (
                            <button
                              className="card-primary run"
                              onClick={() => onRun(task.id)}
                              title="Launch this task into a free pane"
                            >
                              <PlayIcon width={13} height={13} /> Run
                            </button>
                          ) : (
                            <button
                              className="card-primary"
                              onClick={() => onRun(task.id)}
                              title="Re-launch into a free pane"
                            >
                              <RestartIcon width={13} height={13} /> Re-run
                            </button>
                          )}

                          <button
                            className="card-move"
                            disabled={idx >= COLUMN_ORDER.length - 1}
                            aria-label="Move to next column"
                            title="Move to next column"
                            onClick={() => onMove(task.id, COLUMN_ORDER[idx + 1])}
                          >
                            <ChevronRightIcon width={14} height={14} />
                          </button>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
    </aside>
  );
}
