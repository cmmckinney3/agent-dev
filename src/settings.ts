// App settings model. Everything here is a knob that changes real behaviour
// somewhere else in the app — terminal construction, the task scheduler, the
// broadcast bar, run recording, or how an agent process is spawned. Like the
// agent catalog, it is data: persisted with the workspace and normalized
// per-field on load so a schema addition never bricks a stored blob.

/** What happens to a headless task card when its process exits. */
export type HeadlessCompletion =
  /** Always advance Running → Review (the historical behaviour). */
  | "review"
  /** Exit 0 goes straight to Done; anything else stops in Review. */
  | "done-on-success"
  /** Never advance — the card stays in Running for a human to move. */
  | "stay";

export type CursorStyle = "block" | "bar" | "underline";

/** When an agent that needs you, or finishes, raises a desktop notification. */
export type DesktopNotifications = "off" | "background" | "always";

/**
 * Credentials/routing for OpenRouter-backed agents. An agent opts in with
 * `provider: "openrouter"`; the tokens below are then substituted into its
 * env map and launch args at spawn time (see resolveTokens).
 */
export interface OpenRouterSettings {
  /** Master switch — off means openrouter agents can't launch. */
  enabled: boolean;
  /** Stored in the desktop credential vault, omitted from ordinary backups. */
  apiKey: string;
  baseUrl: string;
  /** Default model slug (e.g. `anthropic/claude-sonnet-4`); agents may override. */
  model: string;
}

export interface Settings {
  notifyOnCompletion: boolean;
  desktopNotifications: DesktopNotifications;
  // ---- Terminal ----
  /** xterm font size in px. */
  fontSize: number;
  /** Empty = the built-in monospace stack. */
  fontFamily: string;
  /** Lines of scrollback kept per pane. */
  scrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Copy the selection to the clipboard as soon as it's made. */
  copyOnSelect: boolean;

  // ---- Task board ----
  /** Auto-launch the oldest queued card whenever a pane frees up. */
  autoStartQueued: boolean;
  /** Cap on simultaneous task runs; 0 = limited only by free panes. */
  maxConcurrentRuns: number;
  headlessCompletion: HeadlessCompletion;
  /** Require a second click to delete a task card. */
  confirmTaskDelete: boolean;
  /**
   * Appended to every agent-review prompt. Empty falls back to
   * DEFAULT_REVIEW_INSTRUCTIONS when the prompt is built.
   */
  reviewInstructions: string;
  /**
   * A message to a teammate set to "start a task" may start one. Off pauses
   * that for every teammate; messages still wait in their inboxes.
   */
  messageStarts: boolean;
  /** How long a chain of message-started tasks may get (see messages.ts). */
  messageChainLimit: number;

  // ---- Workspace ----
  /** Require a second click on "Stop all". */
  confirmStopAll: boolean;
  /** Append a carriage return so a broadcast submits instead of just typing. */
  broadcastAppendEnter: boolean;

  // ---- History ----
  /** Record launches on the Usage page. Off = nothing new is written. */
  recordUsage: boolean;
  /** How many run records to keep. */
  usageLimit: number;

  // ---- Providers ----
  openRouter: OpenRouterSettings;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Longest review-instructions text kept; the prompt travels as a CLI argument. */
export const REVIEW_INSTRUCTIONS_MAX = 4000;

/** Checklist used when the review-instructions setting is blank. */
export const DEFAULT_REVIEW_INSTRUCTIONS = [
  "- Does the change do what was asked?",
  "- Look for bugs, regressions, missing tests and unsafe edge cases.",
  "- If it is cheap, run the project's quick checks (tests, type check).",
  "Finish with a verdict line, APPROVE or REQUEST CHANGES, followed by the specific changes needed.",
].join("\n");

export const DEFAULT_SETTINGS: Settings = {
  notifyOnCompletion: true,
  desktopNotifications: "background",
  fontSize: 13,
  fontFamily: "",
  scrollback: 10000,
  cursorStyle: "block",
  cursorBlink: true,
  copyOnSelect: false,

  autoStartQueued: true,
  maxConcurrentRuns: 0,
  headlessCompletion: "review",
  confirmTaskDelete: true,
  reviewInstructions: DEFAULT_REVIEW_INSTRUCTIONS,
  messageStarts: true,
  messageChainLimit: 3,

  confirmStopAll: false,
  broadcastAppendEnter: true,

  recordUsage: true,
  usageLimit: 500,

  openRouter: {
    enabled: false,
    apiKey: "",
    baseUrl: OPENROUTER_BASE_URL,
    model: "",
  },
};

/** Bounds enforced by both the UI controls and normalizeSettings. */
export const FONT_SIZE_RANGE = { min: 9, max: 22 } as const;
export const SCROLLBACK_RANGE = { min: 500, max: 200_000 } as const;
export const CONCURRENCY_RANGE = { min: 0, max: 12 } as const;
/** "Longest message chain": how many message-started tasks may follow each other. */
export const CHAIN_RANGE = { min: 1, max: 10 } as const;
/** Retention choices offered for run history (also the hard cap, at the end). */
export const USAGE_LIMITS = [100, 500, 2000] as const;

export const CURSOR_STYLES: { id: CursorStyle; label: string }[] = [
  { id: "block", label: "Block" },
  { id: "bar", label: "Bar" },
  { id: "underline", label: "Underline" },
];

export const DESKTOP_NOTIFICATIONS: {
  id: DesktopNotifications;
  label: string;
}[] = [
  { id: "background", label: "When Crucible is in the background" },
  { id: "always", label: "Always" },
  { id: "off", label: "Off" },
];

export const HEADLESS_COMPLETIONS: {
  id: HeadlessCompletion;
  label: string;
  hint: string;
}[] = [
  {
    id: "review",
    label: "Move to Review",
    hint: "Every finished headless run waits for a human to check it.",
  },
  {
    id: "done-on-success",
    label: "Done if exit 0, else Review",
    hint: "Clean runs file themselves; failures still surface in Review.",
  },
  {
    id: "stay",
    label: "Leave in Running",
    hint: "Nothing moves on its own — you advance every card by hand.",
  },
];

const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(Math.round(n), min), max);

/**
 * Validate a persisted settings blob field-by-field, falling back to the
 * default for anything missing or out of range (same tolerance as
 * normalizeAgents / normalizeRuns).
 */
export function normalizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (!raw || typeof raw !== "object")
    return { ...d, openRouter: { ...d.openRouter } };
  const r = raw as Record<string, unknown>;
  const bool = (v: unknown, fb: boolean) => (typeof v === "boolean" ? v : fb);
  const str = (v: unknown, fb: string) => (typeof v === "string" ? v : fb);
  const num = (v: unknown, fb: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, min, max) : fb;
  const or = (r.openRouter ?? {}) as Record<string, unknown>;
  return {
    notifyOnCompletion: bool(r.notifyOnCompletion, d.notifyOnCompletion),
    desktopNotifications: DESKTOP_NOTIFICATIONS.some(
      (n) => n.id === r.desktopNotifications,
    )
      ? (r.desktopNotifications as DesktopNotifications)
      : d.desktopNotifications,
    fontSize: num(
      r.fontSize,
      d.fontSize,
      FONT_SIZE_RANGE.min,
      FONT_SIZE_RANGE.max,
    ),
    fontFamily: str(r.fontFamily, d.fontFamily),
    scrollback: num(
      r.scrollback,
      d.scrollback,
      SCROLLBACK_RANGE.min,
      SCROLLBACK_RANGE.max,
    ),
    cursorStyle: CURSOR_STYLES.some((c) => c.id === r.cursorStyle)
      ? (r.cursorStyle as CursorStyle)
      : d.cursorStyle,
    cursorBlink: bool(r.cursorBlink, d.cursorBlink),
    copyOnSelect: bool(r.copyOnSelect, d.copyOnSelect),

    autoStartQueued: bool(r.autoStartQueued, d.autoStartQueued),
    maxConcurrentRuns: num(
      r.maxConcurrentRuns,
      d.maxConcurrentRuns,
      CONCURRENCY_RANGE.min,
      CONCURRENCY_RANGE.max,
    ),
    headlessCompletion: HEADLESS_COMPLETIONS.some(
      (h) => h.id === r.headlessCompletion,
    )
      ? (r.headlessCompletion as HeadlessCompletion)
      : d.headlessCompletion,
    confirmTaskDelete: bool(r.confirmTaskDelete, d.confirmTaskDelete),
    // Empty is kept as-is: it means "use the built-in checklist" at build time.
    reviewInstructions: str(r.reviewInstructions, d.reviewInstructions).slice(
      0,
      REVIEW_INSTRUCTIONS_MAX,
    ),
    messageStarts: bool(r.messageStarts, d.messageStarts),
    messageChainLimit: num(
      r.messageChainLimit,
      d.messageChainLimit,
      CHAIN_RANGE.min,
      CHAIN_RANGE.max,
    ),

    confirmStopAll: bool(r.confirmStopAll, d.confirmStopAll),
    broadcastAppendEnter: bool(r.broadcastAppendEnter, d.broadcastAppendEnter),

    recordUsage: bool(r.recordUsage, d.recordUsage),
    usageLimit: (USAGE_LIMITS as readonly number[]).includes(
      r.usageLimit as number,
    )
      ? (r.usageLimit as number)
      : d.usageLimit,

    openRouter: {
      enabled: bool(or.enabled, d.openRouter.enabled),
      apiKey: str(or.apiKey, d.openRouter.apiKey).trim(),
      baseUrl:
        str(or.baseUrl, d.openRouter.baseUrl).trim() || OPENROUTER_BASE_URL,
      model: str(or.model, d.openRouter.model).trim(),
    },
  };
}
