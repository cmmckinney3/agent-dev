// Split-layout workspace model. The workspace is a row of columns; each column
// stacks one or more panes. Panes can be split (right = new column, down = new
// row in the column), closed individually, and resized by dragging the 1px
// dividers between them. Presets are just quick arrangements on top of this.
//
// Sizes are fr-style weights, relative within their axis. Drag-resizing writes
// the measured pixel sizes back as weights, which freezes the current ratios
// exactly and keeps them stable when the window itself resizes.

export interface PaneSlot {
  /** Stable backend session key (also the React key — never reused). */
  id: string;
  /** Height weight within the column. */
  size: number;
}

export interface PaneColumn {
  id: string;
  /** Width weight across the workspace. */
  size: number;
  panes: PaneSlot[];
}

/** Hard cap — every pane owns a live terminal, so keep the count sane. */
export const MAX_PANES = 8;
/** Resize-drag clamps, so a pane stays usable instead of collapsing. */
export const MIN_COL_PX = 160;
export const MIN_ROW_PX = 100;

export interface LayoutPreset {
  id: string;
  label: string;
  title: string;
  /** Panes per column, left to right. */
  shape: number[];
  /** Column width weights (defaults to equal). */
  colSizes?: number[];
}

export type PaneDropPlacement =
  | "before"
  | "after"
  | "column-before"
  | "column-after";

export type PaneMoveDirection = "up" | "down" | "left" | "right";

export interface PanePosition {
  columnIndex: number;
  paneIndex: number;
  column: PaneColumn;
  pane: PaneSlot;
}

// Preset ids match the v3 `layoutPreset` values so old workspaces migrate
// cleanly. "two-plus-one" used to be two panes over one wide one; columns
// express its nearest equivalent — two stacked beside one tall.
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: "three-columns",
    label: "3 cols",
    title: "Three equal columns",
    shape: [1, 1, 1],
  },
  {
    id: "main-stack",
    label: "Main + stack",
    title: "One large pane with two stacked beside it",
    shape: [1, 2],
    colSizes: [1.55, 0.9],
  },
  {
    id: "two-plus-one",
    label: "2 + 1",
    title: "Two stacked panes beside one tall pane",
    shape: [2, 1],
  },
  {
    id: "four-grid",
    label: "2x2",
    title: "Four pane grid",
    shape: [2, 2],
  },
];

/** All pane ids in visual order (columns left→right, panes top→bottom). */
export const paneIds = (layout: PaneColumn[]): string[] =>
  layout.flatMap((col) => col.panes.map((p) => p.id));

/** Whether the layout currently has a preset's arrangement (sizes ignored). */
export const matchesPreset = (
  layout: PaneColumn[],
  preset: LayoutPreset,
): boolean =>
  layout.length === preset.shape.length &&
  preset.shape.every((count, i) => layout[i].panes.length === count);

export interface PresetResult {
  layout: PaneColumn[];
  /** Panes that do not fit the shape and get dropped. */
  dropped: string[];
  /** Kept panes that land in a different column — their terminal remounts. */
  moved: string[];
  /** Freshly minted pane ids that fill out the shape. */
  added: string[];
}

/**
 * Rearrange the current panes into a preset's shape, filling column-major.
 * Column ids are reused positionally so panes that stay in place keep their
 * mounted terminal; anything that changes column is reported as `moved`.
 */
export function applyPreset(
  current: PaneColumn[],
  preset: LayoutPreset,
  mintPane: () => string,
  mintCol: () => string,
): PresetResult {
  const ids = paneIds(current);
  const needed = preset.shape.reduce((sum, count) => sum + count, 0);
  const added: string[] = [];
  while (ids.length < needed) {
    const id = mintPane();
    ids.push(id);
    added.push(id);
  }
  const dropped = ids.slice(needed);
  const prevCol = new Map<string, string>();
  for (const col of current)
    for (const p of col.panes) prevCol.set(p.id, col.id);
  let cursor = 0;
  const layout = preset.shape.map((count, i) => {
    const panes = ids
      .slice(cursor, cursor + count)
      .map((id) => ({ id, size: 1 }));
    cursor += count;
    return {
      id: current[i]?.id ?? mintCol(),
      size: preset.colSizes?.[i] ?? 1,
      panes,
    };
  });
  const moved = layout.flatMap((col) =>
    col.panes
      .filter((p) => prevCol.has(p.id) && prevCol.get(p.id) !== col.id)
      .map((p) => p.id),
  );
  return { layout, dropped, moved, added };
}

/** Dry run of applyPreset for guarding, without consuming real ids. */
export function previewPreset(
  current: PaneColumn[],
  preset: LayoutPreset,
): { dropped: string[]; moved: string[] } {
  let n = 0;
  const mint = () => `preview-${++n}`;
  const { dropped, moved } = applyPreset(current, preset, mint, mint);
  return { dropped, moved };
}

/**
 * Insert a new single-pane column right after the column holding `paneId`,
 * splitting that column's width between the two.
 */
export function splitColumn(
  layout: PaneColumn[],
  paneId: string,
  newPaneId: string,
  newColId: string,
): PaneColumn[] {
  const at = layout.findIndex((col) => col.panes.some((p) => p.id === paneId));
  if (at === -1) return layout;
  const col = layout[at];
  const next = [...layout];
  next[at] = { ...col, size: col.size / 2 };
  next.splice(at + 1, 0, {
    id: newColId,
    size: col.size / 2,
    panes: [{ id: newPaneId, size: 1 }],
  });
  return next;
}

/** Insert a new pane directly below `paneId`, splitting its height. */
export function splitPane(
  layout: PaneColumn[],
  paneId: string,
  newPaneId: string,
): PaneColumn[] {
  return layout.map((col) => {
    const at = col.panes.findIndex((p) => p.id === paneId);
    if (at === -1) return col;
    const pane = col.panes[at];
    const panes = [...col.panes];
    panes[at] = { ...pane, size: pane.size / 2 };
    panes.splice(at + 1, 0, { id: newPaneId, size: pane.size / 2 });
    return { ...col, panes };
  });
}

/** Remove a pane; a column left empty is removed with it. */
export function removePane(
  layout: PaneColumn[],
  paneId: string,
): PaneColumn[] {
  return layout
    .map((col) => ({
      ...col,
      panes: col.panes.filter((p) => p.id !== paneId),
    }))
    .filter((col) => col.panes.length > 0);
}

/** Locate the column that owns a pane. */
export function columnIdForPane(
  layout: PaneColumn[],
  paneId: string,
): string | undefined {
  return layout.find((col) => col.panes.some((p) => p.id === paneId))?.id;
}

/** Locate a pane plus its visual indexes. */
export function panePosition(
  layout: PaneColumn[],
  paneId: string,
): PanePosition | null {
  for (let columnIndex = 0; columnIndex < layout.length; columnIndex += 1) {
    const column = layout[columnIndex];
    const paneIndex = column.panes.findIndex((p) => p.id === paneId);
    if (paneIndex !== -1) {
      return { columnIndex, paneIndex, column, pane: column.panes[paneIndex] };
    }
  }
  return null;
}

/**
 * Move an existing pane before/after another pane, or into a fresh single-pane
 * column beside the target column. Used by header drag-and-drop so sessions can
 * be reorganized without forcing users through fixed presets.
 */
export function movePane(
  layout: PaneColumn[],
  paneId: string,
  targetPaneId: string,
  placement: PaneDropPlacement,
  mintCol: () => string,
): PaneColumn[] {
  if (paneId === targetPaneId) return layout;

  let moving: PaneSlot | undefined;
  let sourceCol: PaneColumn | undefined;
  const stripped: PaneColumn[] = [];

  for (const col of layout) {
    const panes = col.panes.filter((p) => {
      if (p.id !== paneId) return true;
      moving = p;
      sourceCol = col;
      return false;
    });
    if (panes.length > 0) stripped.push({ ...col, panes });
  }

  if (!moving || !sourceCol) return layout;

  const targetColIndex = stripped.findIndex((col) =>
    col.panes.some((p) => p.id === targetPaneId),
  );
  if (targetColIndex === -1) return layout;

  const targetCol = stripped[targetColIndex];

  if (placement === "before" || placement === "after") {
    const panes = [...targetCol.panes];
    const targetPaneIndex = panes.findIndex((p) => p.id === targetPaneId);
    if (targetPaneIndex === -1) return layout;
    panes.splice(placement === "before" ? targetPaneIndex : targetPaneIndex + 1, 0, moving);
    const next = [...stripped];
    next[targetColIndex] = { ...targetCol, panes };
    return next;
  }

  const sourceColumnWasRemoved = sourceCol.panes.length === 1;
  const newColumn: PaneColumn = sourceColumnWasRemoved
    ? { ...sourceCol, panes: [moving] }
    : { id: mintCol(), size: targetCol.size / 2, panes: [{ ...moving, size: 1 }] };

  const next = [...stripped];
  const insertAt = placement === "column-before" ? targetColIndex : targetColIndex + 1;
  if (!sourceColumnWasRemoved) {
    next[targetColIndex] = { ...targetCol, size: targetCol.size / 2 };
  }
  next.splice(insertAt, 0, newColumn);
  return next;
}

/**
 * Keyboard/button fallback for window management. Up/down reorders within the
 * same stack. Left/right either moves a single-pane column one slot, or peels a
 * pane out of a stack into a neighbouring column.
 */
export function movePaneStep(
  layout: PaneColumn[],
  paneId: string,
  direction: PaneMoveDirection,
  mintCol: () => string,
): PaneColumn[] {
  const pos = panePosition(layout, paneId);
  if (!pos) return layout;

  const { columnIndex, paneIndex, column, pane } = pos;
  if (direction === "up" || direction === "down") {
    const nextIndex = direction === "up" ? paneIndex - 1 : paneIndex + 1;
    if (nextIndex < 0 || nextIndex >= column.panes.length) return layout;
    const panes = [...column.panes];
    [panes[paneIndex], panes[nextIndex]] = [panes[nextIndex], panes[paneIndex]];
    const next = [...layout];
    next[columnIndex] = { ...column, panes };
    return next;
  }

  const next = [...layout];
  if (column.panes.length === 1) {
    const targetIndex = direction === "left" ? columnIndex - 1 : columnIndex + 1;
    if (targetIndex < 0 || targetIndex >= layout.length) return layout;
    const [movingColumn] = next.splice(columnIndex, 1);
    next.splice(targetIndex, 0, movingColumn);
    return next;
  }

  const remaining = column.panes.filter((p) => p.id !== paneId);
  const splitSize = column.size / 2;
  next[columnIndex] = { ...column, size: splitSize, panes: remaining };
  const newColumn: PaneColumn = {
    id: mintCol(),
    size: splitSize,
    panes: [{ ...pane, size: 1 }],
  };
  next.splice(direction === "left" ? columnIndex : columnIndex + 1, 0, newColumn);
  return next;
}

/** Overwrite the column width weights with measured pixels. */
export function withColumnSizes(
  layout: PaneColumn[],
  sizes: number[],
): PaneColumn[] {
  if (sizes.length !== layout.length) return layout;
  return layout.map((col, i) => ({ ...col, size: sizes[i] }));
}

/** Overwrite one column's pane height weights with measured pixels. */
export function withPaneSizes(
  layout: PaneColumn[],
  colId: string,
  sizes: number[],
): PaneColumn[] {
  return layout.map((col) => {
    if (col.id !== colId || col.panes.length !== sizes.length) return col;
    return {
      ...col,
      panes: col.panes.map((p, i) => ({ ...p, size: sizes[i] })),
    };
  });
}

const weight = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 1;

/**
 * Validate a persisted layout. Returns null when the blob is unusable so the
 * caller can fall back to a legacy preset or the default arrangement.
 */
export function normalizeLayout(raw: unknown): PaneColumn[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  const cols: PaneColumn[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") return null;
    const { id, size, panes } = c as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id)) return null;
    seen.add(id);
    if (!Array.isArray(panes) || panes.length === 0) return null;
    const slots: PaneSlot[] = [];
    for (const p of panes) {
      if (!p || typeof p !== "object") return null;
      const slot = p as Record<string, unknown>;
      if (typeof slot.id !== "string" || !slot.id || seen.has(slot.id))
        return null;
      seen.add(slot.id);
      slots.push({ id: slot.id, size: weight(slot.size) });
    }
    cols.push({ id, size: weight(size), panes: slots });
  }
  return paneIds(cols).length <= MAX_PANES ? cols : null;
}

/**
 * Build a layout from a v3 `layoutPreset` id (also the fresh-install default:
 * three columns). Reproduces the legacy `pane-1..n` ids so per-slot settings
 * saved by older versions carry over.
 */
export function layoutFromLegacy(presetId: unknown): PaneColumn[] {
  const preset =
    LAYOUT_PRESETS.find((p) => p.id === presetId) ?? LAYOUT_PRESETS[0];
  let pane = 0;
  let col = 0;
  return applyPreset(
    [],
    preset,
    () => `pane-${++pane}`,
    () => `col-${++col}`,
  ).layout;
}
