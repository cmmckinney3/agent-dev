import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  FolderIcon,
  GripIcon,
  KanbanIcon,
  PencilIcon,
  PlayIcon,
  RestartIcon,
  SearchIcon,
  SplitDownIcon,
  SplitRightIcon,
  StopIcon,
  TerminalIcon,
} from "./icons";
import {
  MAX_PANES,
  type PaneDropPlacement,
  type PaneMoveDirection,
} from "./layout";
import type { RunMeta } from "./usage";
import "@xterm/xterm/css/xterm.css";

export type AgentStatus = "idle" | "running" | "exited";

/** Extra detail accompanying a status change. */
export interface StatusInfo {
  exitCode?: number;
  /** Launch attribution, echoed on the "running" transition (usage history). */
  run?: RunMeta;
}

export interface StartOptions {
  /** Args passed to the spawned process (e.g. a seed prompt). */
  initialArgs?: string[];
  /**
   * Override the slot's program for this launch. Used when launching a task
   * whose agent differs from the slot's current selection — relying on a
   * just-dispatched `setState` to update the `program` prop would be racy.
   */
  program?: string;
  /** Override the launch directory for this run (same race avoidance). */
  cwd?: string;
  /**
   * Launch attribution echoed back through onStatusChange("running") so App
   * can record the run. Task launches pass it explicitly (same race avoidance
   * as program/cwd); manual starts default to the pane's current agent.
   */
  run?: RunMeta;
}

export interface AgentPaneHandle {
  start: (opts?: StartOptions) => Promise<void>;
  stop: () => Promise<void>;
  send: (text: string) => Promise<void>;
  focus: () => void;
}

export interface AgentOption {
  id: string;
  name: string;
}

interface AgentPaneProps {
  id: string;
  /** User-facing session/window title, independent of selected agent. */
  paneTitle: string;
  onPaneTitleChange: (slotId: string, title: string) => void;
  /** Drag-and-drop window reorganization hooks owned by App. */
  dragging?: boolean;
  dropHint?: PaneDropPlacement;
  onPaneDragStart: (
    slotId: string,
    event: React.DragEvent<HTMLElement>,
  ) => void;
  onPaneDragOver: (
    slotId: string,
    event: React.DragEvent<HTMLDivElement>,
  ) => void;
  onPaneDragLeave: (
    slotId: string,
    event: React.DragEvent<HTMLDivElement>,
  ) => void;
  onPaneDrop: (slotId: string, event: React.DragEvent<HTMLDivElement>) => void;
  onPaneDragEnd: () => void;
  name: string;
  program: string;
  accent: string;
  /** Effective working directory (override if set, else the shared default). */
  cwd: string;
  /** This slot's directory override, if any (absent = inheriting default). */
  cwdOverride?: string;
  /** Shared default directory, shown when this slot has no override. */
  defaultCwd: string;
  onCwdChange: (slotId: string, dir: string | null) => void;
  /** Catalog of agents this slot can switch to (while idle). */
  agents: AgentOption[];
  /** Currently selected agent id for this slot. */
  agentId: string;
  onAgentChange: (slotId: string, agentId: string) => void;
  onStatusChange?: (id: string, status: AgentStatus, info?: StatusInfo) => void;
  /** Title of the task bound to this pane, if any — shown as a header badge. */
  taskLabel?: string;
  /** Briefly highlight the pane (e.g. after "Focus pane" from a card). */
  flash?: boolean;
  /** Height weight within this pane's column (fr-like). */
  size: number;
  /** False once the workspace is at its pane cap — disables both splits. */
  canSplit: boolean;
  /** False when this is the last pane — the workspace can't be emptied. */
  canClose: boolean;
  /** Open a new pane in a new column to the right of this one. */
  onSplitRight: () => void;
  /** Open a new pane below this one, in the same column. */
  onSplitDown: () => void;
  moveDisabledReasons: Record<PaneMoveDirection, string | undefined>;
  onMovePane: (direction: PaneMoveDirection) => void;
  onClose: () => void;
}

/** Last path segment, for a compact directory label. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Idle",
  running: "Running",
  exited: "Exited",
};

const DROP_LABEL: Record<PaneDropPlacement, string> = {
  before: "Stack above",
  after: "Stack below",
  "column-before": "New column left",
  "column-after": "New column right",
};

const MOVE_LABEL: Record<PaneMoveDirection, string> = {
  up: "Move up",
  down: "Move down",
  left: "Move left",
  right: "Move right",
};

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const AgentPane = forwardRef<AgentPaneHandle, AgentPaneProps>(
  function AgentPane(
    {
      id,
      paneTitle,
      onPaneTitleChange,
      dragging,
      dropHint,
      onPaneDragStart,
      onPaneDragOver,
      onPaneDragLeave,
      onPaneDrop,
      onPaneDragEnd,
      name,
      program,
      accent,
      cwd,
      cwdOverride,
      defaultCwd,
      onCwdChange,
      agents,
      agentId,
      onAgentChange,
      onStatusChange,
      taskLabel,
      flash,
      size,
      canSplit,
      canClose,
      onSplitRight,
      onSplitDown,
      moveDisabledReasons,
      onMovePane,
      onClose,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const searchRef = useRef<SearchAddon | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const titleInputRef = useRef<HTMLInputElement | null>(null);
    const windowMenuRef = useRef<HTMLDivElement | null>(null);
    const cwdRef = useRef(cwd);
    const statusCbRef = useRef(onStatusChange);
    const [status, setStatus] = useState<AgentStatus>("idle");
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [renaming, setRenaming] = useState(false);
    const [windowMenuOpen, setWindowMenuOpen] = useState(false);
    const [titleDraft, setTitleDraft] = useState(paneTitle);

    useEffect(() => {
      if (!renaming) setTitleDraft(paneTitle);
    }, [paneTitle, renaming]);

    useEffect(() => {
      if (renaming) titleInputRef.current?.select();
    }, [renaming]);

    useEffect(() => {
      if (!windowMenuOpen) return;
      const closeOnPointerDown = (event: PointerEvent) => {
        const target = event.target;
        if (target instanceof Node && windowMenuRef.current?.contains(target)) {
          return;
        }
        setWindowMenuOpen(false);
      };
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") setWindowMenuOpen(false);
      };
      document.addEventListener("pointerdown", closeOnPointerDown);
      document.addEventListener("keydown", closeOnEscape);
      return () => {
        document.removeEventListener("pointerdown", closeOnPointerDown);
        document.removeEventListener("keydown", closeOnEscape);
      };
    }, [windowMenuOpen]);

    useEffect(() => {
      cwdRef.current = cwd;
    }, [cwd]);

    useEffect(() => {
      statusCbRef.current = onStatusChange;
    }, [onStatusChange]);

    // Single funnel for status so the parent always stays in sync.
    const updateStatus = (next: AgentStatus, info?: StatusInfo) => {
      setStatus(next);
      statusCbRef.current?.(id, next, info);
    };

    // Create the terminal once and wire up I/O streaming.
    useEffect(() => {
      const term = new Terminal({
        fontFamily: '"Cascadia Code", "Consolas", "Courier New", monospace',
        fontSize: 13,
        theme: { background: "#0d1117", foreground: "#e6edf3" },
        cursorBlink: true,
        scrollback: 10000,
      });
      const fit = new FitAddon();
      const search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      // Open clicked URLs in the user's real browser via the OS, not a webview.
      term.loadAddon(
        new WebLinksAddon((_event, uri) => {
          openUrl(uri).catch(() => {});
        }),
      );
      if (containerRef.current) {
        term.open(containerRef.current);
        fit.fit();
      }
      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;

      // Ctrl+F (or Cmd+F) opens this pane's find box instead of the OS one.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.key === "f") {
          setSearchOpen(true);
          // Defer focus until the input has rendered.
          window.setTimeout(() => searchInputRef.current?.select(), 0);
          return false;
        }
        return true;
      });

      const outputUnlisten = listen<{ id: string; data: string }>(
        "agent-output",
        (e) => {
          if (e.payload.id !== id) return;
          term.write(decodeBase64(e.payload.data));
        },
      );
      const exitUnlisten = listen<{ id: string; code?: number | null }>(
        "agent-exit",
        (e) => {
          if (e.payload.id !== id) return;
          const code = e.payload.code ?? undefined;
          updateStatus("exited", { exitCode: code });
          // Yellow for a clean/unknown exit, red when the process failed.
          const label =
            code === undefined
              ? "[process exited]"
              : `[process exited — code ${code}]`;
          const color = code ? "\x1b[31m" : "\x1b[33m";
          term.write(`\r\n${color}${label}\x1b[0m\r\n`);
        },
      );

      const dataDisposable = term.onData((data) => {
        invoke("write_to_agent", { id, data }).catch(() => {});
      });

      const resize = () => {
        try {
          fit.fit();
          invoke("resize_agent", {
            id,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => {});
        } catch {
          /* terminal not ready */
        }
      };
      const observer = new ResizeObserver(resize);
      if (containerRef.current) observer.observe(containerRef.current);

      return () => {
        observer.disconnect();
        dataDisposable.dispose();
        outputUnlisten.then((un) => un());
        exitUnlisten.then((un) => un());
        term.dispose();
      };
    }, [id]);

    const start = async (opts?: StartOptions) => {
      const term = termRef.current;
      if (!term) return;
      fitRef.current?.fit();
      term.clear();
      term.reset();
      updateStatus("running", { run: opts?.run ?? { agentId } });
      try {
        await invoke("spawn_agent", {
          id,
          program: opts?.program ?? program,
          args: opts?.initialArgs ?? [],
          cwd: opts?.cwd ?? cwdRef.current,
          cols: term.cols,
          rows: term.rows,
        });
        term.focus();
      } catch (err) {
        term.write(`\r\n\x1b[31m[failed to start: ${String(err)}]\x1b[0m\r\n`);
        updateStatus("exited");
      }
    };

    const stop = async () => {
      await invoke("kill_agent", { id }).catch(() => {});
      updateStatus("idle");
    };

    const send = async (text: string) => {
      await invoke("write_to_agent", { id, data: text }).catch(() => {});
    };

    const focusTerm = () => termRef.current?.focus();

    useImperativeHandle(ref, () => ({ start, stop, send, focus: focusTerm }));

    const findNext = () => {
      if (query) searchRef.current?.findNext(query);
    };
    const findPrev = () => {
      if (query) searchRef.current?.findPrevious(query);
    };
    const closeSearch = () => {
      setSearchOpen(false);
      searchRef.current?.clearDecorations();
      termRef.current?.focus();
    };

    const startRenaming = () => {
      setTitleDraft(paneTitle);
      setRenaming(true);
    };

    const saveTitle = () => {
      onPaneTitleChange(id, titleDraft.trim());
      setRenaming(false);
    };

    const cancelTitle = () => {
      setTitleDraft(paneTitle);
      setRenaming(false);
    };

    const runWindowAction = (action: () => void) => {
      setWindowMenuOpen(false);
      action();
    };

    const moveTitle = (direction: PaneMoveDirection) =>
      moveDisabledReasons[direction] ?? MOVE_LABEL[direction];

    const closeDisabledReason =
      status === "running"
        ? "Stop the agent before closing this pane"
        : canClose
          ? undefined
          : "The last pane can't be closed";

    const browseDir = async () => {
      const picked = await open({
        directory: true,
        multiple: false,
        title: `Working directory for ${name}`,
      });
      if (typeof picked === "string") onCwdChange(id, picked);
    };

    // The directory this slot will actually launch in.
    const effectiveDir = cwdOverride || defaultCwd;
    const dirLabel = effectiveDir ? baseName(effectiveDir) : "Set dir";
    const dirTitle = cwdOverride
      ? `Working in ${cwdOverride} — click to change`
      : defaultCwd
        ? `Inheriting default: ${defaultCwd} — click to override`
        : "No directory set (uses process default) — click to choose";

    return (
      <div
        className={`pane ${flash ? "flash" : ""} ${dragging ? "dragging" : ""} ${
          dropHint ? `drop-${dropHint}` : ""
        }`}
        data-drop-label={dropHint ? DROP_LABEL[dropHint] : undefined}
        onDragOver={(e) => onPaneDragOver(id, e)}
        onDragLeave={(e) => onPaneDragLeave(id, e)}
        onDrop={(e) => onPaneDrop(id, e)}
        style={
          {
            "--pane-accent": accent,
            "--pane-size": size,
          } as React.CSSProperties
        }
      >
        <div className="pane-header">
          <span
            className="pane-grip"
            draggable
            role="button"
            tabIndex={0}
            aria-grabbed={dragging ? "true" : "false"}
            title="Drag to reorganize. Drop in the middle to stack; drop on a side edge to create a column. Running sessions only move within their current column."
            aria-label={`Drag ${paneTitle} to reorganize the workspace`}
            onDragStart={(e) => onPaneDragStart(id, e)}
            onDragEnd={onPaneDragEnd}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                startRenaming();
              }
            }}
          >
            <GripIcon width={14} height={14} />
          </span>
          {renaming ? (
            <form
              className="pane-title-form"
              onSubmit={(e) => {
                e.preventDefault();
                saveTitle();
              }}
            >
              <input
                ref={titleInputRef}
                className="pane-title-input"
                aria-label="Session name"
                value={titleDraft}
                spellCheck={false}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelTitle();
                  }
                }}
              />
            </form>
          ) : (
            <button
              type="button"
              className="pane-title"
              title="Rename session"
              onClick={startRenaming}
              onDoubleClick={startRenaming}
            >
              {paneTitle}
            </button>
          )}
          <button
            type="button"
            className="pane-btn icon pane-rename"
            title="Rename session"
            aria-label={`Rename ${paneTitle}`}
            onClick={startRenaming}
          >
            <PencilIcon width={13} height={13} />
          </button>
          <span className={`status ${status}`}>
            <span className="dot" />
            {STATUS_LABEL[status]}
          </span>
          {status === "running" ? (
            <span className="pane-name">{name}</span>
          ) : (
            <select
              className="pane-select"
              aria-label="Select agent for this pane"
              value={agentId}
              onChange={(e) => onAgentChange(id, e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <span className="pane-prog">{program}</span>
          {taskLabel && (
            <span className="pane-task" title={`Task: ${taskLabel}`}>
              <KanbanIcon width={12} height={12} />
              <span className="pane-task-text">{taskLabel}</span>
            </span>
          )}
          {status === "running" ? (
            <span className="pane-dir static" title={dirTitle}>
              <FolderIcon width={13} height={13} />
              <span className="pane-dir-text">{dirLabel}</span>
            </span>
          ) : (
            <span className="pane-dir-group">
              <button
                type="button"
                className={`pane-dir ${cwdOverride ? "set" : ""}`}
                title={dirTitle}
                onClick={browseDir}
              >
                <FolderIcon width={13} height={13} />
                <span className="pane-dir-text">{dirLabel}</span>
              </button>
              {cwdOverride && (
                <button
                  type="button"
                  className="pane-dir-reset"
                  title="Use launch default"
                  aria-label="Reset to default working directory"
                  onClick={() => onCwdChange(id, null)}
                >
                  ×
                </button>
              )}
            </span>
          )}
          <span className="pane-spacer" />
          <button className="pane-btn" onClick={() => start()}>
            {status === "running" ? (
              <>
                <RestartIcon /> Restart
              </>
            ) : (
              <>
                <PlayIcon /> Start
              </>
            )}
          </button>
          <button
            className="pane-btn"
            onClick={stop}
            disabled={status !== "running"}
          >
            <StopIcon /> Stop
          </button>
          <span className="pane-header-sep" aria-hidden="true" />
          <div className="pane-window-menu" ref={windowMenuRef}>
            <button
              type="button"
              className={`pane-btn pane-window-trigger ${windowMenuOpen ? "open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={windowMenuOpen}
              title="Window actions: rename, split, move, close"
              onClick={() => setWindowMenuOpen((open) => !open)}
            >
              Window <ChevronDownIcon width={13} height={13} />
            </button>
            {windowMenuOpen && (
              <div
                className="pane-window-popover"
                role="menu"
                aria-label={`Window actions for ${paneTitle}`}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="pane-menu-item"
                  onClick={() => runWindowAction(startRenaming)}
                >
                  <PencilIcon width={13} height={13} /> Rename session
                </button>
                <div className="pane-menu-section" aria-hidden="true">
                  Split
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="pane-menu-item"
                  disabled={!canSplit}
                  title={
                    canSplit
                      ? "Split right — open a new pane in a new column"
                      : `Pane limit reached (${MAX_PANES})`
                  }
                  onClick={() => runWindowAction(onSplitRight)}
                >
                  <SplitRightIcon width={13} height={13} /> Split right
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="pane-menu-item"
                  disabled={!canSplit}
                  title={
                    canSplit
                      ? "Split down — open a new pane below"
                      : `Pane limit reached (${MAX_PANES})`
                  }
                  onClick={() => runWindowAction(onSplitDown)}
                >
                  <SplitDownIcon width={13} height={13} /> Split down
                </button>
                <div className="pane-menu-section" aria-hidden="true">
                  Move
                </div>
                <div className="pane-move-grid">
                  <button
                    type="button"
                    role="menuitem"
                    className="pane-menu-item compact"
                    disabled={Boolean(moveDisabledReasons.up)}
                    title={moveTitle("up")}
                    onClick={() => runWindowAction(() => onMovePane("up"))}
                  >
                    <ChevronUpIcon width={13} height={13} /> Up
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="pane-menu-item compact"
                    disabled={Boolean(moveDisabledReasons.down)}
                    title={moveTitle("down")}
                    onClick={() => runWindowAction(() => onMovePane("down"))}
                  >
                    <ChevronDownIcon width={13} height={13} /> Down
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="pane-menu-item compact"
                    disabled={Boolean(moveDisabledReasons.left)}
                    title={moveTitle("left")}
                    onClick={() => runWindowAction(() => onMovePane("left"))}
                  >
                    <ChevronLeftIcon width={13} height={13} /> Left
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="pane-menu-item compact"
                    disabled={Boolean(moveDisabledReasons.right)}
                    title={moveTitle("right")}
                    onClick={() => runWindowAction(() => onMovePane("right"))}
                  >
                    <ChevronRightIcon width={13} height={13} /> Right
                  </button>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="pane-menu-item danger"
                  disabled={Boolean(closeDisabledReason)}
                  title={closeDisabledReason ?? "Close pane"}
                  onClick={() => runWindowAction(onClose)}
                >
                  <CloseIcon width={13} height={13} /> Close pane
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="pane-btn icon"
            disabled={!canSplit}
            title={
              canSplit
                ? "Split right — open a new pane in a new column"
                : `Pane limit reached (${MAX_PANES})`
            }
            aria-label="Split right"
            onClick={onSplitRight}
          >
            <SplitRightIcon width={14} height={14} />
          </button>
          <button
            type="button"
            className="pane-btn icon"
            disabled={!canSplit}
            title={
              canSplit
                ? "Split down — open a new pane below"
                : `Pane limit reached (${MAX_PANES})`
            }
            aria-label="Split down"
            onClick={onSplitDown}
          >
            <SplitDownIcon width={14} height={14} />
          </button>
          <button
            type="button"
            className="pane-btn icon pane-close"
            disabled={Boolean(closeDisabledReason)}
            title={closeDisabledReason ?? "Close pane"}
            aria-label="Close pane"
            onClick={onClose}
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
        <div className="pane-term-wrap" onClick={focusTerm}>
          {searchOpen && (
            <div
              className="pane-search"
              role="search"
              onClick={(e) => e.stopPropagation()}
            >
              <SearchIcon className="pane-search-icon" width={13} height={13} />
              <input
                ref={searchInputRef}
                className="pane-search-input"
                placeholder="Find in terminal…"
                aria-label={`Find in ${name} terminal`}
                value={query}
                spellCheck={false}
                onChange={(e) => {
                  const v = e.target.value;
                  setQuery(v);
                  if (v) searchRef.current?.findNext(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (e.shiftKey) findPrev();
                    else findNext();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    closeSearch();
                  }
                }}
              />
              <button
                type="button"
                className="pane-search-btn"
                title="Previous match (Shift+Enter)"
                aria-label="Previous match"
                onClick={findPrev}
              >
                <ChevronUpIcon width={14} height={14} />
              </button>
              <button
                type="button"
                className="pane-search-btn"
                title="Next match (Enter)"
                aria-label="Next match"
                onClick={findNext}
              >
                <ChevronDownIcon width={14} height={14} />
              </button>
              <button
                type="button"
                className="pane-search-btn"
                title="Close (Esc)"
                aria-label="Close search"
                onClick={closeSearch}
              >
                <CloseIcon width={14} height={14} />
              </button>
            </div>
          )}
          <div className="pane-term" ref={containerRef} />
          {status === "idle" && (
            <div className="pane-empty">
              <TerminalIcon />
              <span className="pane-empty-text">
                <b>{name}</b> is idle
                <br />
                Press <b>Start</b> to launch <code>{program}</code>
                {effectiveDir && (
                  <>
                    {" "}
                    in <b>{baseName(effectiveDir)}</b>
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  },
);

export default AgentPane;
