import { Fragment, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import AgentPane, { AgentPaneHandle, AgentStatus, StatusInfo } from "./AgentPane";
import AgentManager, { AgentDraft } from "./AgentManager";
import TaskBoard from "./TaskBoard";
import { AgentConfig, normalizeAgents, seedArgs } from "./agents";
import {
  columnIdForPane,
  applyPreset,
  LAYOUT_PRESETS,
  LayoutPreset,
  layoutFromLegacy,
  matchesPreset,
  MAX_PANES,
  MIN_COL_PX,
  MIN_ROW_PX,
  movePane,
  movePaneStep,
  normalizeLayout,
  PaneColumn,
  type PaneDropPlacement,
  type PaneMoveDirection,
  paneIds,
  panePosition,
  previewPreset,
  removePane,
  splitColumn,
  splitPane,
  withColumnSizes,
  withPaneSizes,
} from "./layout";
import { Task, TaskDraft, TaskStatus } from "./tasks";
import UsagePage from "./UsagePage";
import {
  MAX_RUN_RECORDS,
  normalizeRuns,
  RunMeta,
  RunRecord,
} from "./usage";
import {
  ActivityIcon,
  BotIcon,
  BroadcastIcon,
  CrucibleIcon,
  FolderIcon,
  PlayIcon,
  SendIcon,
  StopIcon,
  TerminalIcon,
} from "./icons";
import "./App.css";

/** Highest `<prefix>-N` numeric suffix in a list of ids (0 when none). */
const maxSeq = (ids: string[], prefix: string) =>
  ids.reduce((max, id) => {
    const m = id.match(new RegExp(`^${prefix}-(\\d+)$`));
    const n = m ? parseInt(m[1], 10) : NaN;
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

// Workspace setup (directories, agent-per-slot, broadcast targets, tasks) is
// persisted across restarts. Live process state is intentionally not — agents
// are not respawned automatically, and tasks come back as Backlog (see below).
const STORAGE_KEY = "agentdev.workspace.v5";
const LEGACY_KEYS = [
  "agentdev.workspace.v4",
  "agentdev.workspace.v3",
  "agentdev.workspace.v2",
  "agentdev.workspace.v1",
];
interface Persisted {
  cwd: string;
  layout: PaneColumn[];
  slotAgents: Record<string, string>;
  slotNames: Record<string, string>;
  slotCwds: Record<string, string>;
  targets: Record<string, boolean>;
  tasks: Task[];
  boardCollapsed: boolean;
  /** User-editable agent catalog; older blobs without one get the defaults. */
  agents: AgentConfig[];
  /** Run history for the Usage page; older blobs without one start empty. */
  usage: RunRecord[];
}

function loadPersisted(): Partial<Persisted> & {
  resetCount: number;
  agents: AgentConfig[];
  layout: PaneColumn[];
  slotAgents: Record<string, string>;
  slotNames: Record<string, string>;
  usage: RunRecord[];
} {
  const read = (key: string): Partial<Persisted> => {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}");
    } catch {
      return {};
    }
  };
  // Prefer the current blob; fall back through older workspace schemas.
  const sourceKey =
    [STORAGE_KEY, ...LEGACY_KEYS].find((key) => localStorage.getItem(key)) ??
    STORAGE_KEY;
  const data = read(sourceKey);
  const agents = normalizeAgents(data.agents);
  // Every slot/task must reference an agent that exists in the loaded catalog;
  // anything dangling (e.g. the catalog changed shape) falls back to the first.
  const validAgent = (id: string | undefined) =>
    agents.some((a) => a.id === id) ? (id as string) : agents[0].id;
  // Normalize: live state can't survive a restart. A task that was "running" is
  // reset to Backlog, and every task drops its pane binding / queued flag.
  const raw = data.tasks ?? [];
  const resetCount = raw.filter((t) => t.status === "running").length;
  const tasks: Task[] = raw.map((t) => ({
    ...t,
    agentId: validAgent(t.agentId),
    status: t.status === "running" ? ("backlog" as TaskStatus) : t.status,
    paneId: undefined,
    queued: false,
  }));
  // v4 stores the column layout directly; a v3 blob only has a preset id,
  // which maps onto the same pane-1..n ids so its per-slot settings survive.
  const layout =
    normalizeLayout(data.layout) ??
    layoutFromLegacy((data as { layoutPreset?: unknown }).layoutPreset);
  const order = paneIds(layout);
  // Every pane needs an agent; missing ones cycle through the catalog (which
  // reproduces the old alternating claude/codex defaults on a fresh install).
  const storedAgents = data.slotAgents ?? {};
  const slotAgents = Object.fromEntries(
    order.map((id, i) => [
      id,
      agents.some((a) => a.id === storedAgents[id])
        ? storedAgents[id]
        : agents[i % agents.length].id,
    ]),
  );
  const storedNames = data.slotNames ?? {};
  const slotNames = Object.fromEntries(
    order.map((id, i) => [
      id,
      typeof storedNames[id] === "string" && storedNames[id].trim()
        ? storedNames[id].trim()
        : `Session ${i + 1}`,
    ]),
  );
  // Per-slot leftovers for panes that no longer exist are dropped.
  const forLayout = <T,>(m: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(
      Object.entries(m ?? {}).filter(([id]) => order.includes(id)),
    );
  return {
    ...data,
    agents,
    layout,
    slotAgents,
    slotNames,
    slotCwds: forLayout(data.slotCwds),
    targets: forLayout(data.targets),
    tasks,
    resetCount,
    // Runs that were live when the app closed come back as `interrupted`.
    usage: normalizeRuns(data.usage),
  };
}
const persisted = loadPersisted();

// Draggable 1px separator between columns ("col") or between stacked panes
// ("row"). A drag measures the neighbouring tracks in pixels and writes the
// adjusted sizes back as flex weights; arrow keys nudge the boundary for
// keyboard users, and a double-click evens the pair out.
function SplitDivider({
  orientation,
  label,
  valueNow,
  onResize,
}: {
  orientation: "col" | "row";
  label: string;
  /** Percent of the pair's space taken by the leading track (for AT). */
  valueNow: number;
  /** Receives the full pixel sizes of every sibling track on the axis. */
  onResize: (sizesPx: number[]) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    origin: number;
    sizes: number[];
    index: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const alongX = orientation === "col";
  const min = alongX ? MIN_COL_PX : MIN_ROW_PX;

  // Pixel sizes of the sibling tracks (columns/panes), and which pair this
  // divider sits between. Measured from the DOM so weights and pixels can't
  // drift apart.
  const measure = () => {
    const el = ref.current;
    if (!el || !el.parentElement) return null;
    const sizes: number[] = [];
    let index = -1;
    for (const child of Array.from(el.parentElement.children)) {
      if (child === el) index = sizes.length - 1;
      else if (!child.classList.contains("ws-divider")) {
        const rect = child.getBoundingClientRect();
        sizes.push(alongX ? rect.width : rect.height);
      }
    }
    return index >= 0 && index + 1 < sizes.length ? { sizes, index } : null;
  };

  const shiftBoundary = (
    base: { sizes: number[]; index: number },
    delta: number,
  ) => {
    const { sizes, index } = base;
    const pair = sizes[index] + sizes[index + 1];
    // On a squeezed window the pair may not fit two minimums; degrade to
    // "no smaller than half the pair" so dragging still responds.
    const lim = Math.min(min, pair / 2);
    const next = [...sizes];
    next[index] = Math.min(Math.max(sizes[index] + delta, lim), pair - lim);
    next[index + 1] = pair - next[index];
    onResize(next);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const base = measure();
    if (!base) return;
    drag.current = { origin: alongX ? e.clientX : e.clientY, ...base };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const pos = alongX ? e.clientX : e.clientY;
    shiftBoundary(drag.current, pos - drag.current.origin);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
  };

  const equalize = () => {
    const base = measure();
    if (!base) return;
    const pair = base.sizes[base.index] + base.sizes[base.index + 1];
    const next = [...base.sizes];
    next[base.index] = pair / 2;
    next[base.index + 1] = pair / 2;
    onResize(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = alongX
      ? e.key === "ArrowLeft"
        ? -1
        : e.key === "ArrowRight"
          ? 1
          : 0
      : e.key === "ArrowUp"
        ? -1
        : e.key === "ArrowDown"
          ? 1
          : 0;
    if (dir === 0) return;
    e.preventDefault();
    const base = measure();
    if (base) shiftBoundary(base, dir * 32);
  };

  return (
    <div
      ref={ref}
      className={`ws-divider ${orientation} ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation={alongX ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={valueNow}
      tabIndex={0}
      title="Drag to resize — double-click to even out"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={equalize}
      onKeyDown={onKeyDown}
    />
  );
}

/** Percent of a two-track pair taken by the leading track. */
const pairPct = (a: number, b: number) => Math.round((a / (a + b)) * 100);

export default function App() {
  // Which page is on screen. The workspace stays mounted (hidden via CSS)
  // while Usage is shown, so live terminals are never torn down by a switch.
  const [page, setPage] = useState<"workspace" | "usage">("workspace");
  const [cwd, setCwd] = useState(persisted.cwd ?? "");
  const [broadcast, setBroadcast] = useState("");
  // The agent catalog — user-editable via the Agents manager dialog.
  const [agents, setAgents] = useState<AgentConfig[]>(persisted.agents);
  const [agentMgrOpen, setAgentMgrOpen] = useState(false);
  const agentsBtnRef = useRef<HTMLButtonElement | null>(null);
  const [slotAgents, setSlotAgents] = useState(persisted.slotAgents);
  const [slotNames, setSlotNames] = useState<Record<string, string>>(
    persisted.slotNames,
  );
  // Per-slot directory overrides. Absent = inherit the shared default above.
  const [slotCwds, setSlotCwds] = useState<Record<string, string>>(
    persisted.slotCwds ?? {},
  );
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  // Which slots receive a broadcast. Absent = included (opt-out model).
  const [targets, setTargets] = useState<Record<string, boolean>>(
    persisted.targets ?? {},
  );

  // ---- Task board state ----
  const [tasks, setTasks] = useState<Task[]>(persisted.tasks ?? []);
  const [boardCollapsed, setBoardCollapsed] = useState(
    persisted.boardCollapsed ?? false,
  );
  const [layout, setLayout] = useState<PaneColumn[]>(persisted.layout);
  // Pane ids in visual order (columns left→right, top→bottom) — the working
  // set for broadcasts, scheduling, and the run counter.
  const paneOrder = paneIds(layout);
  // Which task (if any) currently owns each pane. Live-only, never persisted.
  const [paneTask, setPaneTask] = useState<Record<string, string | null>>({});
  // Slot to briefly highlight after "Focus pane".
  const [flashSlot, setFlashSlot] = useState<string | null>(null);
  const [dragSlot, setDragSlot] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{
    targetId: string;
    placement: PaneDropPlacement;
  } | null>(null);
  // Run history feeding the Usage page (persisted, capped at MAX_RUN_RECORDS).
  const [usage, setUsage] = useState<RunRecord[]>(persisted.usage);
  // How many tasks were reset Running→Backlog on this load (restart notice).
  const [resetNotice, setResetNotice] = useState(persisted.resetCount ?? 0);
  // Monotonic counters for task/agent ids, seeded past anything restored.
  const taskSeq = useRef(
    (persisted.tasks ?? []).reduce((max, t) => {
      const n = parseInt(t.id.replace(/^task-/, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0),
  );
  const agentSeq = useRef(
    persisted.agents.reduce((max, a) => {
      const n = parseInt(a.id.replace(/^agent-/, ""), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0),
  );
  const runSeq = useRef(
    maxSeq(
      persisted.usage.map((r) => r.id),
      "run",
    ),
  );
  // Monotonic pane/column id counters — ids are never reused, so a new pane
  // can't inherit a dead session's backend key.
  const paneSeq = useRef(maxSeq(paneIds(persisted.layout), "pane"));
  const colSeq = useRef(
    maxSeq(
      persisted.layout.map((c) => c.id),
      "col",
    ),
  );

  // Persist workspace setup whenever it changes.
  useEffect(() => {
    const data: Persisted = {
      cwd,
      layout,
      slotAgents,
      slotNames,
      slotCwds,
      targets,
      tasks,
      boardCollapsed,
      agents,
      usage,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [
    cwd,
    layout,
    slotAgents,
    slotNames,
    slotCwds,
    targets,
    tasks,
    boardCollapsed,
    agents,
    usage,
  ]);
  const [justSent, setJustSent] = useState(false);
  const refs = useRef<Record<string, AgentPaneHandle | null>>({});

  const runningCount = paneOrder.filter(
    (id) => statuses[id] === "running",
  ).length;
  const allRunning = runningCount === paneOrder.length;

  const isTarget = (id: string) => targets[id] !== false;
  const targetSlots = paneOrder.filter(isTarget);
  const toggleTarget = (id: string) =>
    setTargets((prev) => ({ ...prev, [id]: prev[id] === false }));

  // ---- Workspace layout (resizable columns of stacked panes) ----
  const mintPane = () => {
    paneSeq.current += 1;
    return `pane-${paneSeq.current}`;
  };
  const mintCol = () => {
    colSeq.current += 1;
    return `col-${colSeq.current}`;
  };

  const canAddPane = paneOrder.length < MAX_PANES;

  const emptyMoveReasons = (): Record<PaneMoveDirection, string> => ({
    up: "Pane is not in the current layout",
    down: "Pane is not in the current layout",
    left: "Pane is not in the current layout",
    right: "Pane is not in the current layout",
  });

  const defaultSlotName = (slotId: string) => {
    const index = paneOrder.indexOf(slotId);
    return `Session ${index >= 0 ? index + 1 : paneOrder.length + 1}`;
  };

  const slotTitle = (slotId: string) =>
    slotNames[slotId]?.trim() || defaultSlotName(slotId);

  const paneMoveDisabledReasons = (
    slotId: string,
  ): Record<PaneMoveDirection, string | undefined> => {
    const pos = panePosition(layout, slotId);
    if (!pos) return emptyMoveReasons();
    const running = statuses[slotId] === "running";
    const horizontalSafety = running
      ? "Stop this running session before moving it between columns"
      : undefined;
    return {
      up: pos.paneIndex > 0 ? undefined : "Already first in this stack",
      down:
        pos.paneIndex < pos.column.panes.length - 1
          ? undefined
          : "Already last in this stack",
      left:
        horizontalSafety ??
        (pos.column.panes.length > 1 || pos.columnIndex > 0
          ? undefined
          : "No column or stacked pane to move left"),
      right:
        horizontalSafety ??
        (pos.column.panes.length > 1 || pos.columnIndex < layout.length - 1
          ? undefined
          : "No column or stacked pane to move right"),
    };
  };

  const renameSlot = (slotId: string, title: string) => {
    setSlotNames((prev) => {
      const next = { ...prev };
      const clean = title.trim();
      if (clean) next[slotId] = clean;
      else delete next[slotId];
      return next;
    });
  };

  const seedSlotNames = (ids: string[]) =>
    setSlotNames((prev) => ({
      ...prev,
      ...Object.fromEntries(
        ids.map((id, i) => [id, `Session ${paneOrder.length + i + 1}`]),
      ),
    }));

  // New panes cycle through the agent catalog, offset by how many panes are
  // already on screen — same alternating flavour as the old fixed defaults.
  const seedSlotAgents = (ids: string[], startIndex: number) =>
    setSlotAgents((prev) => ({
      ...prev,
      ...Object.fromEntries(
        ids.map((id, i) => [id, agents[(startIndex + i) % agents.length].id]),
      ),
    }));

  const splitRight = (paneId: string) => {
    if (!canAddPane) return;
    const newId = mintPane();
    seedSlotAgents([newId], paneOrder.length);
    seedSlotNames([newId]);
    setLayout((l) => splitColumn(l, paneId, newId, mintCol()));
  };

  const splitDown = (paneId: string) => {
    if (!canAddPane) return;
    const newId = mintPane();
    seedSlotAgents([newId], paneOrder.length);
    seedSlotNames([newId]);
    setLayout((l) => splitPane(l, paneId, newId));
  };

  // Forget every per-slot record of panes that left the layout.
  const dropSlotState = (ids: string[]) => {
    if (ids.length === 0) return;
    const omit = <T,>(m: Record<string, T>): Record<string, T> => {
      const next = { ...m };
      for (const id of ids) delete next[id];
      return next;
    };
    setSlotAgents(omit);
    setSlotNames(omit);
    setSlotCwds(omit);
    setTargets(omit);
    setStatuses(omit);
    setPaneTask(omit);
    for (const id of ids) delete refs.current[id];
  };

  const clearSlotStatus = (slotId: string) =>
    setStatuses((prev) => {
      if (!(slotId in prev)) return prev;
      const next = { ...prev };
      delete next[slotId];
      return next;
    });

  const closePane = (paneId: string) => {
    if (paneOrder.length <= 1 || statuses[paneId] === "running") return;
    setLayout((l) => removePane(l, paneId));
    dropSlotState([paneId]);
  };

  const moveSlot = (slotId: string, direction: PaneMoveDirection) => {
    const reasons = paneMoveDisabledReasons(slotId);
    if (reasons[direction]) return;
    setLayout((l) => movePaneStep(l, slotId, direction, mintCol));
    // Horizontal moves can change the pane's React parent. Running panes are
    // blocked above; for idle/exited panes clear stale runtime status if a
    // remount occurs so the header and scheduler stay aligned.
    if (direction === "left" || direction === "right") clearSlotStatus(slotId);
  };

  // Panes a preset would close, or move to another column (remounting their
  // terminal). Either is destructive for a running agent, so it blocks.
  const presetBlockers = (preset: LayoutPreset) => {
    const { dropped, moved } = previewPreset(layout, preset);
    return [...dropped, ...moved].filter((id) => statuses[id] === "running");
  };

  const switchPreset = (preset: LayoutPreset) => {
    if (presetBlockers(preset).length > 0) return;
    const result = applyPreset(layout, preset, mintPane, mintCol);
    if (result.added.length > 0) {
      seedSlotAgents(result.added, paneOrder.length);
      seedSlotNames(result.added);
    }
    dropSlotState(result.dropped);
    // A moved pane remounts with a fresh, idle terminal — clear its stale
    // status so the scheduler and header agree with what's on screen.
    if (result.moved.length > 0)
      setStatuses((prev) => {
        const next = { ...prev };
        for (const id of result.moved) delete next[id];
        return next;
      });
    setLayout(result.layout);
  };

  const dropPlacement = (
    e: React.DragEvent<HTMLDivElement>,
  ): PaneDropPlacement => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const edge = rect.width >= 260 ? rect.width * 0.22 : 0;
    if (edge && x < edge) return "column-before";
    if (edge && x > rect.width - edge) return "column-after";
    return y < rect.height / 2 ? "before" : "after";
  };

  const isCrossColumnMove = (
    sourceId: string,
    targetId: string,
    placement: PaneDropPlacement,
  ) =>
    placement === "column-before" ||
    placement === "column-after" ||
    columnIdForPane(layout, sourceId) !== columnIdForPane(layout, targetId);

  const canDropPane = (
    sourceId: string,
    targetId: string,
    placement: PaneDropPlacement,
  ) => {
    if (!sourceId || sourceId === targetId) return false;
    // Moving a mounted xterm to a different React parent remounts it, so protect
    // live sessions. Same-column ordering is safe because the keyed child stays
    // under the same parent.
    if (
      statuses[sourceId] === "running" &&
      isCrossColumnMove(sourceId, targetId, placement)
    ) {
      return false;
    }
    return true;
  };

  const paneDragStart = (
    slotId: string,
    e: React.DragEvent<HTMLElement>,
  ) => {
    setDragSlot(slotId);
    setDropHint(null);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-agentdev-pane", slotId);
    e.dataTransfer.setData("text/plain", slotTitle(slotId));
  };

  const paneDragOver = (targetId: string, e: React.DragEvent<HTMLDivElement>) => {
    const sourceId =
      dragSlot || e.dataTransfer.getData("application/x-agentdev-pane");
    const placement = dropPlacement(e);
    if (!canDropPane(sourceId, targetId, placement)) {
      e.dataTransfer.dropEffect = "none";
      if (dropHint?.targetId === targetId) setDropHint(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropHint((prev) =>
      prev?.targetId === targetId && prev.placement === placement
        ? prev
        : { targetId, placement },
    );
  };

  const paneDragLeave = (
    targetId: string,
    e: React.DragEvent<HTMLDivElement>,
  ) => {
    const related = e.relatedTarget;
    if (related instanceof Node && e.currentTarget.contains(related)) return;
    setDropHint((prev) => (prev?.targetId === targetId ? null : prev));
  };

  const paneDrop = (targetId: string, e: React.DragEvent<HTMLDivElement>) => {
    const sourceId =
      dragSlot || e.dataTransfer.getData("application/x-agentdev-pane");
    const placement = dropPlacement(e);
    setDropHint(null);
    setDragSlot(null);
    if (!canDropPane(sourceId, targetId, placement)) return;
    e.preventDefault();
    const remountsPane = isCrossColumnMove(sourceId, targetId, placement);
    setLayout((l) => movePane(l, sourceId, targetId, placement, mintCol));
    if (remountsPane) clearSlotStatus(sourceId);
  };

  const paneDragEnd = () => {
    setDragSlot(null);
    setDropHint(null);
  };

  const changeAgent = (slotId: string, agentId: string) =>
    setSlotAgents((prev) => ({ ...prev, [slotId]: agentId }));

  const changeCwd = (slotId: string, dir: string | null) =>
    setSlotCwds((prev) => {
      const next = { ...prev };
      if (dir) next[slotId] = dir;
      else delete next[slotId];
      return next;
    });

  // ---- Agent catalog ----
  const agentById = (id: string) =>
    agents.find((a) => a.id === id) ?? agents[0];

  const addAgent = (draft: AgentDraft) => {
    agentSeq.current += 1;
    setAgents((prev) => [
      ...prev,
      { id: `agent-${agentSeq.current}`, ...draft },
    ]);
  };

  const updateAgent = (id: string, patch: AgentDraft) =>
    setAgents((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    );

  // Deleting an agent remaps anything referencing it to the first remaining
  // one, so slots and cards never point at a missing catalog entry.
  const deleteAgent = (id: string) => {
    const fallback = agents.find((a) => a.id !== id);
    if (!fallback) return; // last agent — the manager disables delete anyway
    setAgents((prev) => prev.filter((a) => a.id !== id));
    setSlotAgents((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([slot, aid]) => [
          slot,
          aid === id ? fallback.id : aid,
        ]),
      ),
    );
    setTasks((prev) =>
      prev.map((t) => (t.agentId === id ? { ...t, agentId: fallback.id } : t)),
    );
  };

  const closeAgentMgr = () => {
    setAgentMgrOpen(false);
    agentsBtnRef.current?.focus();
  };

  // ---- Task CRUD ----
  const addTask = (draft: TaskDraft) => {
    taskSeq.current += 1;
    const id = `task-${taskSeq.current}`;
    setTasks((prev) => [...prev, { id, status: "backlog", ...draft }]);
  };

  const updateTask = (id: string, patch: Partial<Task>) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  // Release the pane a task holds (if any): stop the process and clear binding.
  const unbindPane = (taskId: string) => {
    const slot = paneOrder.find((s) => paneTask[s] === taskId);
    if (!slot) return;
    refs.current[slot]?.stop();
    setPaneTask((prev) => ({ ...prev, [slot]: null }));
  };

  const deleteTask = (id: string) => {
    unbindPane(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  // ---- Scheduling ----
  // First pane that is not busy with a process and has no task bound to it.
  const freeSlot = (): string | undefined =>
    paneOrder.find((s) => {
      const st = statuses[s];
      const idle = st === undefined || st === "idle" || st === "exited";
      return idle && !paneTask[s];
    });

  // Launch a task into a free pane, seeding the agent with its prompt. If no
  // pane is free, the card stays in Backlog flagged `queued`.
  const startTask = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const slot = freeSlot();
    if (!slot) {
      // Avoid a redundant write (it would re-trigger the scheduler effect).
      if (!(task.status === "backlog" && task.queued)) {
        updateTask(id, { status: "backlog", queued: true, paneId: undefined });
      }
      return;
    }
    const agent = agentById(task.agentId);
    const args = seedArgs(agent, task.prompt, task.mode);
    // Reflect the task's agent/dir in the slot UI (header name, accent, badge).
    changeAgent(slot, task.agentId);
    if (task.cwd) changeCwd(slot, task.cwd);
    // Launch with explicit program/cwd so we don't depend on the just-dispatched
    // setState above reaching the pane's props within this same tick.
    const launchCwd = task.cwd ?? slotCwds[slot] ?? cwd;
    refs.current[slot]?.start({
      program: agent.program,
      initialArgs: args,
      cwd: launchCwd,
      run: {
        agentId: task.agentId,
        taskId: task.id,
        taskTitle: task.title,
        mode: task.mode,
      },
    });
    setPaneTask((prev) => ({ ...prev, [slot]: id }));
    updateTask(id, {
      status: "running",
      paneId: slot,
      queued: false,
      lastExitCode: undefined, // a fresh run clears the previous outcome badge
    });
  };

  // Column move from the board (DnD + ◀ ▶). Moving into Running launches;
  // moving out of Running releases the pane.
  const moveTask = (id: string, status: TaskStatus) => {
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    if (status === "running") {
      startTask(id);
      return;
    }
    unbindPane(id);
    updateTask(id, { status, paneId: undefined, queued: false });
  };

  const focusPane = (slot: string) => {
    refs.current[slot]?.focus();
    setFlashSlot(slot);
    window.setTimeout(
      () => setFlashSlot((s) => (s === slot ? null : s)),
      700,
    );
  };

  // ---- Usage history ----
  // Close the slot's open run record, if any. "idle" = stopped from the app,
  // "exited" = the process ended on its own (exitCode says how).
  const closeRun = (
    slotId: string,
    outcome: "completed" | "stopped",
    exitCode?: number,
  ) =>
    setUsage((prev) =>
      prev.map((r) =>
        r.slotId === slotId && r.outcome === "running"
          ? { ...r, outcome, endedAt: Date.now(), exitCode }
          : r,
      ),
    );

  // Record a fresh launch. Snapshots the agent/session names so history stays
  // readable after catalog edits, renames, or pane closes.
  const openRun = (slotId: string, meta: RunMeta) => {
    runSeq.current += 1;
    const record: RunRecord = {
      id: `run-${runSeq.current}`,
      agentId: meta.agentId,
      agentName: agents.find((a) => a.id === meta.agentId)?.name ?? meta.agentId,
      slotId,
      session: slotTitle(slotId),
      taskId: meta.taskId,
      taskTitle: meta.taskTitle,
      mode: meta.mode,
      startedAt: Date.now(),
      outcome: "running",
    };
    setUsage((prev) => {
      // Restarting a live pane replaces its process without an idle/exited
      // step in between — the old record closes as stopped here.
      const closed = prev.map((r) =>
        r.slotId === slotId && r.outcome === "running"
          ? { ...r, outcome: "stopped" as const, endedAt: Date.now() }
          : r,
      );
      return [...closed, record].slice(-MAX_RUN_RECORDS);
    });
  };

  // Drop finished history; live runs stay so their records can still close.
  const clearUsage = () =>
    setUsage((prev) => prev.filter((r) => r.outcome === "running"));

  // Centralized status handling: record usage and advance/cleanup task cards
  // on pane lifecycle.
  const handleStatusChange = (
    slot: string,
    status: AgentStatus,
    info?: StatusInfo,
  ) => {
    setStatuses((prev) => ({ ...prev, [slot]: status }));
    if (status === "running") {
      if (info?.run) openRun(slot, info.run);
    } else if (status === "exited") {
      closeRun(slot, "completed", info?.exitCode);
    } else {
      closeRun(slot, "stopped");
    }
    const taskId = paneTask[slot];
    if (!taskId) return;
    if (status === "exited") {
      const task = tasks.find((t) => t.id === taskId);
      // Headless runs end when work is done → advance to Review, keeping the
      // exit code so the card shows ok/failed. Interactive agents are advanced
      // by hand, so leave the card in Running.
      if (task?.mode === "headless") {
        updateTask(taskId, {
          status: "review",
          paneId: undefined,
          lastExitCode: info?.exitCode,
        });
      } else {
        updateTask(taskId, { paneId: undefined });
      }
      setPaneTask((prev) => ({ ...prev, [slot]: null }));
    } else if (status === "idle") {
      // Manual stop — release the pane, keep the card where it is.
      updateTask(taskId, { paneId: undefined });
      setPaneTask((prev) => ({ ...prev, [slot]: null }));
    }
  };

  // Drain the queue: when a pane frees up, auto-start the oldest queued card.
  useEffect(() => {
    const next = tasks.find((t) => t.queued && t.status === "backlog");
    if (!next) return;
    if (!freeSlot()) return;
    startTask(next.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, statuses, paneTask, layout]);

  const sendLabel =
    targetSlots.length === paneOrder.length
      ? "Send to all"
      : targetSlots.length === 1
        ? `Send to ${slotTitle(targetSlots[0])}`
        : `Send to ${targetSlots.length}`;

  const browse = async () => {
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Select working directory",
    });
    if (typeof picked === "string") setCwd(picked);
  };

  const startAll = () =>
    paneOrder.forEach((id) => refs.current[id]?.start());
  const stopAll = () =>
    paneOrder.forEach((id) => refs.current[id]?.stop());

  const sendBroadcast = async () => {
    const text = broadcast.trim();
    if (!text || targetSlots.length === 0) return;
    const payload = text + "\r";
    await Promise.all(targetSlots.map((id) => refs.current[id]?.send(payload)));
    setBroadcast("");
    setJustSent(true);
    window.setTimeout(() => setJustSent(false), 600);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <CrucibleIcon width={19} height={19} />
          </span>
          Crucible
        </div>
        <div className="topbar-divider" />
        <nav className="page-switch" aria-label="Page">
          <button
            type="button"
            className={`page-btn ${page === "workspace" ? "on" : ""}`}
            aria-current={page === "workspace" ? "page" : undefined}
            onClick={() => setPage("workspace")}
          >
            <TerminalIcon width={14} height={14} /> Workspace
          </button>
          <button
            type="button"
            className={`page-btn ${page === "usage" ? "on" : ""}`}
            aria-current={page === "usage" ? "page" : undefined}
            title="Per-agent run history: runs, session time, and outcomes"
            onClick={() => setPage("usage")}
          >
            <ActivityIcon width={14} height={14} /> Usage
          </button>
        </nav>
        <div className="topbar-divider" />
        <div className="field">
          <FolderIcon className="field-icon" width={15} height={15} />
          <input
            id="cwd"
            className="cwd-input"
            aria-label="Default working directory"
            placeholder="Default working directory — panes inherit unless overridden"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            spellCheck={false}
          />
          <button className="field-btn" onClick={browse}>
            Browse…
          </button>
        </div>
        <button
          ref={agentsBtnRef}
          className="btn"
          onClick={() => setAgentMgrOpen(true)}
          title="Add, edit, or remove the agents available to panes and tasks"
        >
          <BotIcon /> Agents
        </button>
        <div className="layout-switch" role="group" aria-label="Pane layout presets">
          {LAYOUT_PRESETS.map((preset) => {
            const active = matchesPreset(layout, preset);
            const disabled = presetBlockers(preset).length > 0;
            return (
              <button
                key={preset.id}
                type="button"
                className={`layout-btn ${active ? "on" : ""}`}
                aria-pressed={active}
                disabled={disabled}
                title={
                  disabled
                    ? "Stop the agents this arrangement would move or close first"
                    : preset.title
                }
                onClick={() => switchPreset(preset)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <span
          className={`run-pill ${runningCount > 0 ? "active" : ""}`}
          role="status"
          aria-live="polite"
        >
          <span className="dot" />
          {runningCount}/{paneOrder.length} live
        </span>
        <button className="btn primary" onClick={startAll} disabled={allRunning}>
          <PlayIcon /> Start all
        </button>
        <button className="btn" onClick={stopAll} disabled={runningCount === 0}>
          <StopIcon /> Stop all
        </button>
      </header>

      {agentMgrOpen && (
        <AgentManager
          agents={agents}
          onAdd={addAgent}
          onUpdate={updateAgent}
          onDelete={deleteAgent}
          onClose={closeAgentMgr}
        />
      )}

      {page === "usage" && (
        <UsagePage runs={usage} agents={agents} onClear={clearUsage} />
      )}

      {/* The workspace is hidden, not unmounted, while Usage is shown —
          unmounting would dispose the xterm terminals of live sessions. */}
      <div className={`main-row ${page === "workspace" ? "" : "page-hidden"}`}>
        <TaskBoard
          tasks={tasks}
          agents={agents}
          defaultCwd={cwd}
          collapsed={boardCollapsed}
          onToggleCollapsed={() => setBoardCollapsed((c) => !c)}
          onAdd={addTask}
          onUpdate={updateTask}
          onDelete={deleteTask}
          onMove={moveTask}
          onRun={startTask}
          onFocusPane={focusPane}
          resetNotice={resetNotice}
          onDismissReset={() => setResetNotice(0)}
        />

        <main className="workspace">
          {layout.map((col, ci) => (
            <Fragment key={col.id}>
              {ci > 0 && (
                <SplitDivider
                  orientation="col"
                  label={`Resize columns ${ci} and ${ci + 1}`}
                  valueNow={pairPct(layout[ci - 1].size, col.size)}
                  onResize={(sizes) =>
                    setLayout((l) => withColumnSizes(l, sizes))
                  }
                />
              )}
              <div
                className="ws-col"
                style={{ "--col-size": col.size } as React.CSSProperties}
              >
                {col.panes.map((pane, pi) => {
                  const slotId = pane.id;
                  const agentId = slotAgents[slotId];
                  const agent = agentById(agentId);
                  const override = slotCwds[slotId];
                  const boundId = paneTask[slotId];
                  const boundTask = boundId
                    ? tasks.find((t) => t.id === boundId)
                    : undefined;
                  const moveReasons = paneMoveDisabledReasons(slotId);
                  return (
                    <Fragment key={slotId}>
                      {pi > 0 && (
                        <SplitDivider
                          orientation="row"
                          label={`Resize panes ${pi} and ${pi + 1}`}
                          valueNow={pairPct(col.panes[pi - 1].size, pane.size)}
                          onResize={(sizes) =>
                            setLayout((l) => withPaneSizes(l, col.id, sizes))
                          }
                        />
                      )}
                      <AgentPane
                        ref={(h) => {
                          refs.current[slotId] = h;
                        }}
                        id={slotId}
                        paneTitle={slotTitle(slotId)}
                        onPaneTitleChange={renameSlot}
                        dragging={dragSlot === slotId}
                        dropHint={
                          dropHint?.targetId === slotId ? dropHint.placement : undefined
                        }
                        onPaneDragStart={paneDragStart}
                        onPaneDragOver={paneDragOver}
                        onPaneDragLeave={paneDragLeave}
                        onPaneDrop={paneDrop}
                        onPaneDragEnd={paneDragEnd}
                        name={agent.name}
                        program={agent.program}
                        accent={agent.accent}
                        cwd={override ?? cwd}
                        cwdOverride={override}
                        defaultCwd={cwd}
                        onCwdChange={changeCwd}
                        agents={agents}
                        agentId={agentId}
                        onAgentChange={changeAgent}
                        onStatusChange={handleStatusChange}
                        taskLabel={boundTask?.title}
                        flash={flashSlot === slotId}
                        size={pane.size}
                        canSplit={canAddPane}
                        canClose={paneOrder.length > 1}
                        onSplitRight={() => splitRight(slotId)}
                        onSplitDown={() => splitDown(slotId)}
                        moveDisabledReasons={moveReasons}
                        onMovePane={(direction) => moveSlot(slotId, direction)}
                        onClose={() => closePane(slotId)}
                      />
                    </Fragment>
                  );
                })}
              </div>
            </Fragment>
          ))}
        </main>
      </div>

      <footer
        className={`broadcast ${justSent ? "sent" : ""} ${
          page === "workspace" ? "" : "page-hidden"
        }`}
      >
        <div className="broadcast-lead">
          <span className="broadcast-icon">
            <BroadcastIcon width={17} height={17} />
          </span>
          <span className="broadcast-label">Broadcast</span>
        </div>
        <div className="targets">
          {paneOrder.map((slotId, i) => {
            const agent = agentById(slotAgents[slotId]);
            const title = slotTitle(slotId);
            const on = isTarget(slotId);
            const running = statuses[slotId] === "running";
            return (
              <button
                key={slotId}
                type="button"
                className={`target-chip ${running ? "live" : ""} ${
                  on ? "" : "off"
                }`}
                style={{ "--chip-accent": agent.accent } as React.CSSProperties}
                aria-pressed={on}
                title={
                  on
                    ? `${title} (${agent.name}) receives broadcasts — click to exclude`
                    : `${title} (${agent.name}) excluded — click to include`
                }
                onClick={() => toggleTarget(slotId)}
              >
                <span className="chip-index">{i + 1}</span>
                <span className="dot" />
                <span className="chip-title">{title}</span>
                <span className="chip-agent">{agent.name}</span>
              </button>
            );
          })}
        </div>
        <input
          className="broadcast-input"
          aria-label="Broadcast message to selected panes"
          placeholder="Type once, send to every selected pane…"
          value={broadcast}
          onChange={(e) => setBroadcast(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendBroadcast();
          }}
          spellCheck={false}
        />
        <span className="kbd">⏎ Enter</span>
        <button
          className="btn broadcast-send"
          onClick={sendBroadcast}
          disabled={!broadcast.trim() || targetSlots.length === 0}
        >
          <SendIcon /> {sendLabel}
        </button>
      </footer>
    </div>
  );
}
