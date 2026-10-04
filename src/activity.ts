// Agent activity: what the agent inside a live terminal is doing, inferred from
// the PTY stream alone so it works for any CLI on PATH. Pure — sessions.ts feeds
// it events and a clock, and the tests drive it with explicit timestamps.
//
// Working   the agent is producing output on its own
// Needs you it is blocked on the user (OSC 9, a bell, or an approval prompt)
// Done      it finished a turn the user started, and the user has not looked
// Idle      quiet, with nothing new to see

export type Activity = "working" | "waiting" | "done" | "idle";

export interface ActivityState {
  activity: Activity;
  /** When the current activity began. */
  since: number;
  /** Why the agent needs you (waiting), or how the process ended (done). */
  reason?: string;
  /** A turn was started (seeded prompt or a submitted line) and has not ended. */
  turn: boolean;
  /** Any output has arrived since launch. */
  outputSeen: boolean;
  lastOutputAt: number;
  /** Last user input or resize: output right after one is an echo or redraw. */
  lastNudgeAt: number;
  /** Start of the current run of closely spaced output chunks. */
  burstAt?: number;
  /** Output arrived while not working; the screen is checked once it settles. */
  unchecked: boolean;
  /**
   * The CLI reports through Crucible's Claude Code hooks (a hook event has
   * arrived): a turn starts and ends when it says so, and output on its own is
   * the interface redrawing, not work.
   */
  hooked?: boolean;
  /** A hook said it needs you: only an answer, or another hook, moves it on. */
  held?: boolean;
}

/** Output this soon after input or a resize is an echo or a redraw. */
export const ECHO_MS = 400;
/** Output chunks closer together than this belong to one burst. */
export const BURST_GAP_MS = 250;
/** A burst this long counts as work even without a submitted turn. */
export const BURST_MS = 300;
/** Working ends after this long without output. */
export const QUIET_MS = 2000;
/** Before the first output a CLI is still starting up; give it longer. */
export const STARTUP_MS = 10000;
/** Non-empty screen lines checked for an approval prompt. */
export const SCREEN_LINES = 10;
/** Longest reason kept; it can reach a desktop notification. */
export const REASON_MAX = 160;

export const ACTIVITY_LABELS: Record<Activity, string> = {
  waiting: "Needs you",
  working: "Working",
  done: "Done",
  idle: "Idle",
};
/** Dashboard section order: what needs the user first. */
export const ACTIVITY_ORDER: Activity[] = [
  "waiting",
  "working",
  "done",
  "idle",
];

/** Prompts that mean the agent is blocked until the user answers. */
export const QUESTION_PATTERNS: RegExp[] = [
  // Claude Code and Codex approvals: "Do you want to proceed?",
  // "Would you like to run the following command?"
  /\b(?:do you want to|would you like to)\b.*\?/i,
  // "Allow command?", "Approve edits?", "Do you trust the files in this folder?"
  /\b(?:allow|approve|trust)\b[^.!]*\?$/i,
  // (y/n), [Y/n], (yes/no)
  /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/i,
  /\bpress enter to (?:continue|confirm|proceed)\b/i,
];
/** A numbered choice menu with its cursor on an option: "❯ 1. Yes". */
export const MENU_PATTERN = /^[❯›▸>]\s*\d{1,2}[.)]\s+\S/;
export const WAITING_PATTERNS: RegExp[] = [...QUESTION_PATTERNS, MENU_PATTERN];

/** Terminal focus and mouse reports: the terminal talking, not the user. */
const REPORT = /^(?:\x1b\[[IO]|\x1b\[<[\d;]+[mM]|\x1b\[M[\s\S]{3})+$/;

/** Strip control characters, collapse whitespace and cap the length. */
export function cleanReason(text: string): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > REASON_MAX
    ? `${flat.slice(0, REASON_MAX - 1).trimEnd()}…`
    : flat;
}

/** Box-drawing borders around a TUI prompt are not part of its text. */
const screenLine = (line: string) => line.replace(/[─-╿]/g, " ").trim();

/**
 * The approval prompt on screen, if there is one: the question line when it can
 * be found, so the user sees what is being asked rather than "❯ 1. Yes".
 */
export function waitingReason(lines: string[]): string | undefined {
  const tail = lines.map(screenLine).filter(Boolean).slice(-SCREEN_LINES);
  const question = [...tail]
    .reverse()
    .find((line) => QUESTION_PATTERNS.some((p) => p.test(line)));
  if (question) return cleanReason(question);
  const menu = tail.findIndex((line) => MENU_PATTERN.test(line));
  if (menu < 0) return undefined;
  const asked = tail
    .slice(0, menu)
    .reverse()
    .find((line) => line.endsWith("?"));
  return cleanReason(asked ?? "Waiting for you to choose an option");
}

export function initialActivity(now: number, seeded: boolean): ActivityState {
  return {
    activity: seeded ? "working" : "idle",
    since: now,
    turn: seeded,
    outputSeen: false,
    lastOutputAt: now,
    lastNudgeAt: 0,
    unchecked: false,
  };
}

/** Did the visible status change? Listeners only hear about real transitions. */
export const activityChanged = (a: ActivityState, b: ActivityState) =>
  a.activity !== b.activity || a.reason !== b.reason;

const become = (
  s: ActivityState,
  activity: Activity,
  since: number,
  reason?: string,
): ActivityState =>
  s.activity === activity && s.reason === reason
    ? s
    : { ...s, activity, since, reason, held: undefined };

export function onOutput(s: ActivityState, now: number): ActivityState {
  const gap = now - s.lastOutputAt;
  const next: ActivityState = { ...s, lastOutputAt: now, outputSeen: true };
  if (s.activity === "working") return next;
  // The permission dialog drawing itself is not the agent getting back to work.
  if (s.held) return next;
  if (now - s.lastNudgeAt < ECHO_MS) return next;
  const burstAt =
    s.burstAt !== undefined && s.outputSeen && gap < BURST_GAP_MS
      ? s.burstAt
      : now;
  if (s.turn || (!s.hooked && now - burstAt >= BURST_MS))
    return {
      ...become(next, "working", now),
      burstAt: undefined,
      unchecked: false,
    };
  return { ...next, burstAt, unchecked: true };
}

export function onInput(
  s: ActivityState,
  now: number,
  data: string,
): ActivityState {
  const next: ActivityState = { ...s, lastNudgeAt: now };
  if (REPORT.test(data)) return next;
  if (/[\r\n]/.test(data)) next.turn = true;
  // In Claude Code a lone Esc interrupts the turn (or rejects a permission
  // request), and no Stop hook follows: the turn is over and was seen.
  const interrupt = s.hooked && data === "\x1b";
  if (interrupt) next.turn = false;
  // Answering a prompt, or typing into a finished pane, means it has been seen.
  if (
    s.activity === "waiting" ||
    s.activity === "done" ||
    (interrupt && s.activity === "working")
  )
    return become(next, "idle", now);
  return next;
}

/**
 * An event from Crucible's Claude Code hooks, read from an OSC 777 sequence
 * (`crucible;<event>;<kind>;<text>`, written by desktop.rs).
 */
export type HookSignal =
  | { kind: "prompt" }
  | { kind: "stop" }
  /** `soft`: a notification, which never replaces a more specific reason. */
  | { kind: "waiting"; reason: string; soft?: boolean }
  /** Claude Code's own "waiting for your input": the turn is long over. */
  | { kind: "idle" }
  | { kind: "other" };

/** Notification types that mean Claude Code is blocked on the user. */
const NEEDS_YOU = new Set([
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);

/** The hook event an OSC 777 payload carries; undefined when it is not Crucible's. */
export function parseHook(data: string): HookSignal | undefined {
  const [tag, event, kind = "", ...rest] = data.split(";");
  if (tag !== "crucible" || !event) return undefined;
  const text = cleanReason(rest.join(";"));
  const label = kind.replace(/_/g, " ").trim();
  switch (event) {
    case "UserPromptSubmit":
      return { kind: "prompt" };
    case "Stop":
      return { kind: "stop" };
    case "StopFailure":
      return {
        kind: "waiting",
        reason: cleanReason(
          `Stopped by an error${label ? ` (${label})` : ""}${text ? `: ${text}` : ""}`,
        ),
      };
    case "PermissionRequest":
      return {
        kind: "waiting",
        reason: cleanReason(
          `Allow ${kind || "a tool"}${text ? `: ${text}` : ""}?`,
        ),
      };
    case "Notification":
      if (kind === "idle_prompt") return { kind: "idle" };
      return NEEDS_YOU.has(kind)
        ? {
            kind: "waiting",
            reason: text || "Claude Code needs your input",
            soft: true,
          }
        : { kind: "other" };
    default:
      return { kind: "other" };
  }
}

/** A hook event: the CLI says exactly what it is doing. */
export function onHook(
  s: ActivityState,
  now: number,
  signal: HookSignal,
): ActivityState {
  const next: ActivityState = { ...s, hooked: true };
  switch (signal.kind) {
    case "prompt":
      return {
        ...become(next, "working", s.activity === "working" ? s.since : now),
        turn: true,
        burstAt: undefined,
        unchecked: false,
      };
    case "stop":
      return { ...become(next, "done", now), turn: false, unchecked: false };
    case "waiting":
      if (signal.soft && s.activity === "waiting") return next;
      return {
        ...become(
          next,
          "waiting",
          s.activity === "waiting" ? s.since : now,
          signal.reason,
        ),
        held: true,
        unchecked: false,
      };
    case "idle":
      return s.activity === "working"
        ? { ...become(next, s.turn ? "done" : "idle", now), turn: false }
        : next;
    default:
      return next;
  }
}

export const onResize = (s: ActivityState, now: number): ActivityState => ({
  ...s,
  lastNudgeAt: now,
});

/** OSC 9 or another explicit request from the agent. */
export function onAttention(
  s: ActivityState,
  now: number,
  reason: string,
): ActivityState {
  return become(
    s,
    "waiting",
    s.activity === "waiting" ? s.since : now,
    cleanReason(reason) || "The agent asked for your attention",
  );
}

/** A terminal bell, unless it answers the user's own keystroke (tab completion). */
export const onBell = (s: ActivityState, now: number): ActivityState =>
  now - s.lastNudgeAt < ECHO_MS ? s : onAttention(s, now, "Terminal bell");

/**
 * Called about once a second. Reads the screen only when output has settled
 * and there is something to decide, so `screen` is a thunk.
 */
export function onTick(
  s: ActivityState,
  now: number,
  screen: () => string[],
): ActivityState {
  const quiet = s.outputSeen ? QUIET_MS : STARTUP_MS;
  if (now - s.lastOutputAt < quiet) return s;
  if (s.activity === "working") {
    const reason = waitingReason(screen());
    if (reason) return { ...become(s, "waiting", now, reason) };
    return {
      ...become(s, s.turn ? "done" : "idle", s.lastOutputAt),
      turn: false,
    };
  }
  if (!s.unchecked) return s;
  // A prompt printed in one chunk never looked like work; catch it here.
  const reason = waitingReason(screen());
  const next = { ...s, unchecked: false };
  return reason ? become(next, "waiting", now, reason) : next;
}

/** The user looked at the pane: a finished turn is no longer news. */
export const onSeen = (s: ActivityState, now: number): ActivityState =>
  s.activity === "done" ? become(s, "idle", now) : s;

/** The process ended. A stop the user asked for is already seen. */
export function onExit(
  s: ActivityState,
  now: number,
  reason: string,
  seen = false,
): ActivityState {
  return {
    ...become(s, seen ? "idle" : "done", now, reason),
    turn: false,
    unchecked: false,
  };
}

/** "now", "45s", "9m", "2h", "3d". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
