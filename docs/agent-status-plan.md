# Implementation plan — Agent status, Dashboard and notifications

Status: phase 1 implemented 2026-10-01 (see `docs/development-checkpoint.md`) ·
Research and rationale: `docs/bridgemind-research.md` (sections 4 and 5)

**Changed while building phase 1** (the rest of this document is the plan as
written):

- No "you were watching it" shortcut. The plan marked a turn seen when it
  finished in the active pane of a focused window. Every launch focuses its
  terminal, so a task that started in the background counted as watched and
  skipped Done. Done now stays until the pane is clicked or typed in.
- Below 1100px the Dashboard floats over the panes instead of docking: docked
  beside a 240px task rail at the 900px minimum it left about 150px per pane
  column. Opening a row from the floating Dashboard closes it.
- Tiles show the count over the label (no dot); "Needs you" did not fit beside
  a dot in a quarter of 300px.
- `Workspace.dashboardOpen` is a required boolean defaulting to false, like
  `boardCollapsed`, rather than optional.
- Real prompt wording was checked against the installed CLIs (Claude Code
  2.1.284, Codex 0.159.3) and pinned in the tests, including Claude Code's
  folder-trust question "Is this a project you created or one you trust?".

## 1. Why this feature

Crucible knows whether a process is running, but not what the agent inside it is
doing. A pane says "Running" whether the agent is busy, finished its turn ten
minutes ago, or has been stuck on a permission prompt since lunch. The only
"needs you" signal is OSC 9, which few CLIs send by default. With several agents
across several projects, the owner has to look at every pane to find the one
waiting.

BridgeMind's answer, which the owner picked, is a per-agent status (_Needs you_,
_Working_, _Done_, _Idle_ with time in state), desktop notifications, and a
Dashboard listing every agent by status. It is also the prerequisite for agent
messaging later: delivery has to know whether the recipient is idle.

## 2. Phases

| Phase | Scope                                                                         |
| ----- | ----------------------------------------------------------------------------- |
| 1     | Activity model, pane header status, Dashboard, desktop notifications          |
| 1b    | Claude Code hooks as a precise signal (after testing hooks on Windows)        |
| 2     | Runs that end in a verdict: read the reviewer's `APPROVE` / `REQUEST CHANGES` |
| 3     | Look and feel: neutral near-black palette, project rail, slimmer headers      |

This document specifies phase 1. Phases 2 and 3 get their own section when
started.

## 3. Phase 1 behaviour

### Activity

Every session with a live process has an **activity**, shown in its pane header
and on the Dashboard:

- **Working** — the agent is producing output on its own (not echoing your
  typing or redrawing after a resize).
- **Needs you** — the agent is blocked on you: it sent OSC 9 or a terminal bell,
  or it went quiet with an approval prompt on screen (`Do you want to …?`,
  `(y/n)`, a numbered choice menu, `Allow …?`, `Press Enter to continue`).
  The matched line is shown as the reason.
- **Done** — the agent finished a turn you started (a task's seeded prompt, or
  something you submitted with Enter) and you have not looked at it since.
- **Idle** — quiet, with nothing new to see.

A process that ends is **Done** (with its exit code) until seen, then **Idle**.
Typing into a pane, clicking it or focusing it marks it seen. Answering a _Needs
you_ prompt returns it to Idle until output resumes.

Detection is heuristic and engine-neutral, so it works for any CLI on `PATH`:

- Output within `ECHO_MS` (400 ms) of your own input or a resize is an echo or a
  redraw and never starts _Working_.
- Other output starts _Working_ when a turn is pending, or when it continues for
  `BURST_MS` (300 ms), so a single stray redraw does not flip the status.
- _Working_ ends after `QUIET_MS` (2 s) without output. The last eight non-empty
  lines on screen are then checked against `WAITING_PATTERNS`: a match is _Needs
  you_; otherwise _Done_ if a turn was pending, else _Idle_.
- OSC 9 and BEL go straight to _Needs you_.

### Pane header

The status chip shows the activity while the process runs (Working, Needs you,
Done, Idle, each with its own dot colour) and the process state otherwise
(Ready, Starting, Exited, Failed to start). A _Needs you_ chip carries the reason
as its tooltip.

### Dashboard

A right-hand panel on the Workspace page, toggled from a header button that
shows the _Needs you_ count. Open/closed persists with the workspace.

- Four count tiles: Needs you, Working, Done, Idle.
- Sections in that order, each listing sessions across **all** projects. A row
  shows the agent's accent dot, the task title (or session name), "agent ·
  project", and the status with time in state ("Needs you · 9m"). A _Needs you_
  row adds the reason line.
- Clicking a row switches to its project, focuses the pane, marks it seen and
  flashes a ring around it (a steady ring under reduced motion).
- Sessions never started are not listed. An empty Dashboard says how to start one.

### Notifications

A new setting, **Desktop notifications**: Off, When Crucible is in the
background (default), Always. On a transition to _Needs you_ or _Done_, Crucible
sends a desktop notification: the title is the status, the body names the
session, agent and project, plus the reason. Run completion keeps its in-app
toast and taskbar flash (`notifyOnCompletion`).

Notifications go through `tauri-plugin-notification`. The body never contains
terminal output beyond the matched prompt line (control characters stripped,
capped at 160 characters).

## 4. Data model

### `src/activity.ts` (new, pure; no React, no Tauri)

```ts
export type Activity = "working" | "waiting" | "done" | "idle";
export interface ActivityState {
  activity: Activity;
  since: number;
  reason?: string; // waiting: the matched line or the OSC 9 message
  turn: boolean; // a submitted turn is pending
  lastOutputAt: number;
  lastNudgeAt: number; // last input or resize
  burstAt?: number;
}
export const ECHO_MS = 400,
  BURST_MS = 300,
  QUIET_MS = 2000;
export const WAITING_PATTERNS: RegExp[];
export function waitingReason(lines: string[]): string | undefined;
export function initialActivity(now: number, seeded: boolean): ActivityState;
export function onOutput(s: ActivityState, now: number): ActivityState;
export function onInput(
  s: ActivityState,
  now: number,
  data: string,
): ActivityState;
export function onResize(s: ActivityState, now: number): ActivityState;
export function onAttention(
  s: ActivityState,
  now: number,
  reason: string,
): ActivityState;
export function onTick(
  s: ActivityState,
  now: number,
  screen: () => string[],
): ActivityState;
export function onSeen(s: ActivityState, now: number): ActivityState;
export function onExit(
  s: ActivityState,
  now: number,
  reason: string,
): ActivityState;
export function formatElapsed(ms: number): string; // "now", "45s", "9m", "2h", "3d"
export function cleanReason(text: string): string; // strip controls, cap length
```

Every function returns the same object when nothing changed, so callers can
publish only on a real transition. `screen` is a thunk, so the buffer is only
read when _Working_ actually goes quiet.

### `src/sessions.ts`

- `Session` gains `activity?: ActivityState` (reset by `startSession`, which
  learns whether the launch was seeded through a new `Launch.seeded` flag).
- Hooks: `agent-output` → `onOutput`; `term.onData` → `onInput`; `fitSession`
  → `onResize`; OSC 9 and `term.onBell` → `onAttention`; `agent-exit`, stop and
  failure → `onExit`.
- New exports: `tickActivity(now?)` (App drives it once a second, so the module
  holds no timers and stays testable), `markSeen(id)`, `sessionActivity(id)`,
  `subscribeActivity(fn)`. Activity listeners fire only on transitions, never
  per output chunk.
- `screenTail(term)` reads the viewport's last eight non-empty lines with
  `translateToString(true)`.

### `src/settings.ts`

- `desktopNotifications: "off" | "background" | "always"`, default
  `"background"`, normalized like `headlessCompletion`.

### `src/workspace.ts`

- `dashboardOpen?: boolean` on `Workspace`, kept when boolean, default false. No
  `STORAGE_KEY` bump: optional and additive, like `boardCollapsed`.

## 5. App wiring (`src/App.tsx`)

- A one-second interval calls `tickActivity()`; an `activity` record in state is
  fed by `subscribeActivity`.
- Transitions to _Needs you_ or _Done_ call `notifyDesktop` when the setting and
  `document.hasFocus()` allow it.
- `startTask` passes `seeded: true`; `startManual` passes `seeded` only for a
  resume (which carries no prompt, so false).
- `showSession` marks the session seen and sets a `flash` pane id cleared after
  1.6 s. `AgentPane`'s `onActive` marks it seen too.
- The rail maximum subtracts the Dashboard's width when it is open.

## 6. UI

- `src/Dashboard.tsx` (new): presentation only; props are the rows and
  `onOpen`. Rows are buttons with `aria-label`s that read the status aloud;
  sections are lists with headings.
- `src/AgentPane.tsx`: activity-aware status chip, `flash` class.
- `src/SettingsPage.tsx`: the Desktop notifications row (searchable).
- `src/Premium.css`: Dashboard panel, tiles, rows, status colours, flash ring
  with a `prefers-reduced-motion` fallback. Tokens only; `:focus-visible` on
  every row.
- `src/icons.tsx`: a `DashboardIcon`.

## 7. Native

- `tauri-plugin-notification` in `Cargo.toml`, registered in `lib.rs`;
  `@tauri-apps/plugin-notification` in `package.json`; `notification:default` in
  `capabilities/default.json`.
- Permission is requested once, the first time a notification would be sent.

## 8. Acceptance

- `npm test` passes, with new `tests/activity.test.mjs` covering echo and resize
  discounting, burst detection, turn → Done, no turn → Idle, every waiting
  pattern (and lines that must not match), OSC 9/BEL, seen, exit, and identity
  returns. The session-lifecycle stub gains `onBell` and a buffer.
- `npm run build` passes (strict `tsc`).
- `cargo test --offline` passes after the plugin is fetched once.
- Driven in the vite dev server: Dashboard open/close, tiles and sections render
  from seeded state, rows are keyboard reachable, no horizontal overflow at
  900×600, no console errors.
- Native, with Claude Code: a task run shows Working → Done; a permission prompt
  shows Needs you with its reason; a notification arrives with the window in
  the background.
