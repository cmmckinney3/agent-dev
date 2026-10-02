import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AgentConfig } from "./agents";
import { Settings } from "./settings";
import { ACTIVITY_LABELS, ActivityState } from "./activity";
import { PaneDropPlacement, PaneMoveDirection } from "./layout";
import {
  configureSession,
  fitSession,
  getSession,
  isBusy,
  sessionState,
  subscribeSessions,
} from "./sessions";
import { basename } from "./workspace";
import {
  PlayIcon,
  StopIcon,
  CloseIcon,
  SearchIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GripIcon,
  FolderIcon,
  TerminalIcon,
  SplitRightIcon,
  SplitDownIcon,
  PencilIcon,
} from "./icons";
import "@xterm/xterm/css/xterm.css";

interface Props {
  id: string;
  title: string;
  agent: AgentConfig;
  agents: AgentConfig[];
  cwd: string;
  settings: Settings;
  taskTitle?: string;
  size: number;
  expanded: boolean;
  active: boolean;
  /** What the agent is doing, while its process runs. */
  activity?: ActivityState;
  /** Set when opened from the Dashboard; a new value replays the ring. */
  flash?: number;
  canClose: boolean;
  canSplit: boolean;
  blocked?: string;
  dropHint?: PaneDropPlacement;
  onStart: () => void;
  onStop: () => void;
  onExpand: () => void;
  onActive: () => void;
  onAgent: (id: string) => void;
  onRename: (title: string) => void;
  onCwd: (cwd: string | undefined) => void;
  onClose: () => void;
  onSplit: (direction: "right" | "down") => void;
  onMove: (direction: PaneMoveDirection) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}
/** Gap between the overflow trigger and its menu; mirrors `.session-menu`. */
const MENU_OFFSET = 6;
const labels = {
  idle: "Ready",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  exited: "Exited",
  failed: "Failed to start",
};
export default function AgentPane(p: Props) {
  const container = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState(() => sessionState(p.id));
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState(false);
  // A stacked pane in a short window has no room below its trigger, so the menu
  // takes whichever side has more and caps itself to that space. Room is
  // measured against `.main-row`, which is what actually clips it — measuring
  // against the viewport flips the menu into a top edge it cannot cross.
  const [menuPlace, setMenuPlace] = useState<{ up: boolean; room: number }>();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.title);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const live = isBusy(status);
  // While the process runs, say what the agent is doing rather than "Running".
  const doing = status === "running" ? p.activity : undefined;
  useEffect(() => {
    const s = getSession(p.id, p.settings);
    const host = container.current!;
    if (s.term.element) host.appendChild(s.term.element);
    else s.term.open(host);
    s.showSearch = () => setSearch(true);
    configureSession(s, p.settings);
    fitSession(s);
    const observer = new ResizeObserver(() => fitSession(s));
    observer.observe(host);
    const selection = s.term.onSelectionChange(() => {
      if (p.settings.copyOnSelect && s.term.hasSelection())
        void navigator.clipboard
          .writeText(s.term.getSelection())
          .catch((e) => setError(String(e)));
    });
    setStatus(s.status);
    setError(s.error);
    const un = subscribeSessions((e) => {
      if (e.id === p.id) {
        setStatus(e.status);
        setError(e.error);
      }
    });
    return () => {
      observer.disconnect();
      selection.dispose();
      un();
      s.showSearch = undefined;
    };
  }, [p.id, p.settings]);
  useEffect(() => {
    if (search) findRef.current?.focus();
  }, [search]);
  useEffect(() => {
    if (!menu) return;
    const menuBox = menuRef.current?.getBoundingClientRect();
    const triggerBox = triggerRef.current?.getBoundingClientRect();
    const clip = menuRef.current
      ?.closest(".main-row")
      ?.getBoundingClientRect() ?? {
      top: 0,
      bottom: window.innerHeight,
    };
    if (menuBox && triggerBox) {
      // The menu sits MENU_OFFSET past the trigger edge on either side.
      const below = clip.bottom - triggerBox.bottom - MENU_OFFSET;
      const above = triggerBox.top - clip.top - MENU_OFFSET;
      const up = below < menuBox.height && above > below;
      setMenuPlace({ up, room: Math.max(0, up ? above : below) });
    }
    menuRef.current
      ?.querySelector<HTMLElement>("button:not(:disabled)")
      ?.focus();
    const close = (e: PointerEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      )
        setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      setMenuPlace(undefined);
    };
  }, [menu]);
  const action = (fn: () => void) => {
    setMenu(false);
    triggerRef.current?.focus();
    fn();
  };
  const find = (previous = false) => {
    const s = getSession(p.id, p.settings);
    if (query) {
      if (previous) s.search.findPrevious(query);
      else s.search.findNext(query);
    }
  };
  const browse = async () => {
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: `Folder for ${p.title}`,
      });
      if (typeof path === "string") p.onCwd(path);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section
      className={`pane ${p.active ? "active-pane" : ""} ${p.dropHint ? `drop-${p.dropHint}` : ""}`}
      style={
        {
          "--pane-size": p.size,
          "--pane-accent": p.agent.accent,
        } as React.CSSProperties
      }
      aria-label={p.title}
      onFocusCapture={p.onActive}
      onPointerDown={p.onActive}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
    >
      <header className="session-header">
        <div className="session-title-row">
          <span
            className="session-grip"
            draggable
            onDragStart={p.onDragStart}
            onDragEnd={p.onDragEnd}
            title="Drag to move session"
          >
            <GripIcon width={13} />
          </span>
          {renaming ? (
            <input
              autoFocus
              className="session-rename"
              aria-label="Session name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  p.onRename(name.trim() || p.title);
                  setRenaming(false);
                }
                if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={() => {
                p.onRename(name.trim() || p.title);
                setRenaming(false);
              }}
            />
          ) : (
            <button
              className="session-title"
              onDoubleClick={() => {
                setName(p.title);
                setRenaming(true);
              }}
              onClick={p.onActive}
              title="Double-click to rename"
            >
              {p.title}
            </button>
          )}
          <span
            className={`session-status ${doing ? `activity-${doing.activity}` : status}`}
            title={doing?.reason}
          >
            <span />
            {doing ? ACTIVITY_LABELS[doing.activity] : labels[status]}
          </span>
          <button
            className="icon-button"
            disabled={
              status === "starting" ||
              status === "stopping" ||
              (!live && Boolean(p.blocked))
            }
            onClick={live ? p.onStop : p.onStart}
            aria-label={`${live ? "Stop" : "Start"} ${p.title}`}
            title={p.blocked || (live ? "Stop session" : "Start session")}
          >
            {live ? <StopIcon /> : <PlayIcon />}
          </button>
          <button
            className="icon-button"
            onClick={p.onExpand}
            aria-label={p.expanded ? "Restore layout" : "Focus session"}
            title="Focus session (Ctrl+Shift+E)"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path
                d={
                  p.expanded
                    ? "M8 3v5H3m18 0h-5V3M3 16h5v5m8 0v-5h5"
                    : "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"
                }
              />
            </svg>
          </button>
          <div className="session-menu-wrap">
            <button
              ref={triggerRef}
              className="icon-button"
              aria-label={`Actions for ${p.title}`}
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <span aria-hidden="true">•••</span>
            </button>
            {menu && (
              <div
                ref={menuRef}
                className={`session-menu ${menuPlace?.up ? "up" : ""}`}
                style={
                  menuPlace ? { maxHeight: `${menuPlace.room}px` } : undefined
                }
                role="menu"
                aria-label={`Actions for ${p.title}`}
                onKeyDown={(e) => {
                  const buttons = Array.from(
                    menuRef.current!.querySelectorAll<HTMLButtonElement>(
                      "button:not(:disabled)",
                    ),
                  );
                  const i = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    action(() => {});
                  }
                  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                    e.preventDefault();
                    buttons[
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? buttons.length - 1
                          : (i +
                              (e.key === "ArrowDown" ? 1 : -1) +
                              buttons.length) %
                            buttons.length
                    ]?.focus();
                  }
                  if (e.key === "Tab") setMenu(false);
                }}
              >
                <button
                  role="menuitem"
                  onClick={() =>
                    action(() => {
                      setName(p.title);
                      setRenaming(true);
                    })
                  }
                >
                  <PencilIcon />
                  Rename session
                </button>
                <button
                  role="menuitem"
                  onClick={() => action(() => setSearch(true))}
                >
                  <SearchIcon />
                  Find in output <kbd>Ctrl+F</kbd>
                </button>
                <button
                  role="menuitem"
                  disabled={!p.canSplit}
                  onClick={() => action(() => p.onSplit("right"))}
                >
                  <SplitRightIcon />
                  Split right
                </button>
                <button
                  role="menuitem"
                  disabled={!p.canSplit}
                  onClick={() => action(() => p.onSplit("down"))}
                >
                  <SplitDownIcon />
                  Split below
                </button>
                {(["left", "right", "up", "down"] as const).map((d) => (
                  <button
                    key={d}
                    role="menuitem"
                    onClick={() => action(() => p.onMove(d))}
                  >
                    Move {d}
                  </button>
                ))}
                <button
                  role="menuitem"
                  disabled={live}
                  onClick={() => action(() => p.onCwd(undefined))}
                >
                  Use project folder
                </button>
                <button
                  role="menuitem"
                  className="danger-text"
                  disabled={!p.canClose || live}
                  onClick={() => action(p.onClose)}
                >
                  <CloseIcon />
                  Close session
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="session-context">
          <span className="agent-identity" style={{ color: p.agent.accent }}>
            {live ? (
              p.agent.name
            ) : (
              <select
                aria-label={`Agent for ${p.title}`}
                value={p.agent.id}
                onChange={(e) => p.onAgent(e.target.value)}
              >
                {p.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </span>
          <button
            className="context-folder"
            disabled={live}
            onClick={browse}
            title={p.cwd || "Choose a folder"}
          >
            <FolderIcon width={12} />
            <span>{basename(p.cwd) || "Choose folder"}</span>
          </button>
          {p.taskTitle && (
            <span className="session-task" title={p.taskTitle}>
              {p.taskTitle}
            </span>
          )}
        </div>
      </header>
      {(error || p.blocked) && (
        <div className="session-error" role="status">
          {error || p.blocked}
        </div>
      )}
      <div
        className="pane-term-wrap"
        onClick={() => getSession(p.id, p.settings).term.focus()}
      >
        {search && (
          <div className="pane-search" onClick={(e) => e.stopPropagation()}>
            <SearchIcon />
            <input
              ref={findRef}
              aria-label={`Find in ${p.title}`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                getSession(p.id, p.settings).search.findNext(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") find(e.shiftKey);
                if (e.key === "Escape") {
                  setSearch(false);
                  getSession(p.id, p.settings).term.focus();
                }
              }}
            />
            <button
              className="icon-button"
              aria-label="Previous match"
              onClick={() => find(true)}
            >
              <ChevronUpIcon />
            </button>
            <button
              className="icon-button"
              aria-label="Next match"
              onClick={() => find()}
            >
              <ChevronDownIcon />
            </button>
            <button
              className="icon-button"
              aria-label="Close search"
              onClick={() => {
                setSearch(false);
                getSession(p.id, p.settings).search.clearDecorations();
              }}
            >
              <CloseIcon />
            </button>
          </div>
        )}
        <div className="pane-term" ref={container} />
        {status === "idle" && (
          <div className="pane-empty">
            <TerminalIcon />
            <span className="pane-empty-text">
              <b>{p.agent.name}</b>
              <br />
              {p.cwd
                ? `Ready in ${basename(p.cwd)}`
                : "Choose a project to get started"}
            </span>
            <button
              className="btn"
              disabled={Boolean(p.blocked)}
              onClick={p.onStart}
            >
              <PlayIcon />
              Start session
            </button>
          </div>
        )}
      </div>
      {p.flash !== undefined && (
        <span key={p.flash} className="pane-flash" aria-hidden="true" />
      )}
    </section>
  );
}
