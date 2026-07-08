# Implementation Plan — Kanban Task Board ("Vibe Kanban")

Status: proposed · Target: AgentDev (Tauri 2 + React 19)
Author: planning pass, 2026-06-30

## 1. Goal

Add a Kanban task board that turns AgentDev from "four parallel terminals with
broadcast typing" into an agentic development environment: you write task cards,
and **launching a card spawns its agent into a terminal pane with the task's
prompt already seeded**, then the card advances through columns as work
progresses.

This is the single feature that closes the biggest gap with BridgeSpace, and it
is mostly a UI/state layer over infrastructure that already exists.

### In scope (v1)
- A collapsible left "Tasks" rail with four columns: Backlog → Running → Review → Done.
- Create / edit / delete task cards (title, prompt, agent, optional working dir).
- Drag-and-drop between columns (native HTML5 DnD, no new dependency) + button fallback for a11y.
- Launch a card into a free pane, seeding the agent with the task prompt.
- Lifecycle sync: a pane running a task shows which task; process exit advances the card.
- Persistence of tasks across restarts (extends the existing localStorage scheme).

### Out of scope (deferred — see §9)
- Inter-agent messaging / shared mailbox (BridgeSwarm).
- Roles (coordinator/builder/reviewer/scout).
- Configurable agent catalog, integrated editor, git panel.

## 2. Current architecture (grounded recap)

| Concern | Where | Notes |
|---|---|---|
| App shell, all top-level state, persistence | `src/App.tsx` | `Persisted` interface (`App.tsx:42`), `STORAGE_KEY = "agentdev.workspace.v1"` (`App.tsx:41`) |
| Agent catalog | `src/App.tsx:21` | `AGENTS: AgentConfig[]` — Claude Code, Codex |
| Pane = terminal + PTY binding | `src/AgentPane.tsx` | Imperative handle `{ start, stop, send }` (`AgentPane.tsx:31`) |
| Pane → backend spawn | `AgentPane.tsx:211` | `invoke("spawn_agent", { id, program, args, cwd, cols, rows })` |
| Backend PTY manager | `src-tauri/src/lib.rs` | `spawn_agent` forwards `args: Vec<String>` to the process (`lib.rs:61,94`); exit emitted as `agent-exit` (`lib.rs:138`) |
| Status flow up | `AgentPane.tsx:119` `updateStatus` → `onStatusChange(id, status)` | App stores `statuses: Record<slotId, AgentStatus>` (`App.tsx:68`) |
| Pane refs (to call start/stop/send) | `App.tsx:84` | `refs.current[slotId]` |

Key existing primitives the board reuses verbatim:
- `refs.current[slotId].start()` to launch a pane.
- `spawn_agent`'s `args` field to pass an initial prompt to the CLI.
- The `statuses` map + `agent-exit` event to detect completion.
- The `Persisted` localStorage pattern to store tasks.

## 3. Key design decisions

### D1. How a task's prompt reaches the agent — **CLI arg, not typed injection**
`start()` spawns a fresh process; the CLI's TUI needs time to initialize before
it accepts typed input, so calling `send(prompt)` right after `start()` is racy.
Instead, pass the prompt as a launch argument — `spawn_agent` already forwards
`args` to the process. Both current agents support a seed prompt positionally:
- Claude Code: `claude "<prompt>"` (interactive, seeded) or `claude -p "<prompt>"` (headless/print).
- Codex: `codex "<prompt>"` (interactive) or `codex exec "<prompt>"` (non-interactive).

Encode this per-agent so it stays data-driven (see `AgentConfig` extension in §4).

### D2. Interactive vs headless — **support both; default interactive, manual Review advance**
- **Interactive (default):** agent launches seeded with the prompt and *keeps
  running* after it finishes — you watch and steer in the pane. The process does
  not exit on completion, so the card moves to **Running** and the human drags it
  to Review/Done. This matches AgentDev's current "watch the agent work" UX.
- **Headless (per-task opt-in):** agent runs in print/exec mode and the process
  exits when done. The `agent-exit` event then auto-advances the card Running → Review.

A per-task `mode: "interactive" | "headless"` flag selects behavior. Auto-advance
logic keys off `mode`, so we never falsely mark an interactive agent "done" just
because someone quit it.

### D3. Scheduling against a fixed 4-pane pool — **first free pane, else queue**
Only four panes exist. `startTask` assigns the first pane whose status is `idle`
or `exited` and that has no task already bound. If none is free, the card stays in
Backlog flagged `queued`; a small notice explains why. (The board makes raising
the pane count attractive later, but v1 keeps four.)

### D4. Drag-and-drop — **native HTML5 DnD, no library**
Keeps with the hand-built, "no AI slop" design system (see memory: UI design
system). Cards are `draggable`; columns are drop targets. Because native DnD is
not keyboard-accessible, every card also gets explicit "move" affordances
(◀ ▶ or a small menu) so the board is operable without a mouse.

### D5. Layout — **collapsible left rail, board + panes visible together**
The point is to manage cards while watching code stream into panes, so the board
sits beside the 2×2 grid, not in a separate view. New grid:
`topbar / [board rail | workspace] / broadcast`. Rail collapses to an icon strip;
collapsed/expanded state persists.

## 4. Data model

Add to `src/App.tsx` (or a new `src/tasks.ts`):

```ts
type TaskStatus = "backlog" | "running" | "review" | "done";
type TaskMode = "interactive" | "headless";

interface Task {
  id: string;            // e.g. `task-${counter}` (avoid Date-based ids for testability)
  title: string;
  prompt: string;
  agentId: string;       // references AGENTS[].id
  cwd?: string;          // optional override; absent = shared default cwd
  mode: TaskMode;        // default "interactive"
  status: TaskStatus;
  paneId?: string;       // slot it is bound to while running
  queued?: boolean;      // wanted to run but no free pane
}
```

Extend the agent catalog so prompt delivery is data-driven:

```ts
interface AgentConfig {
  id: string; name: string; program: string; accent: string;
  // Build launch args for a seeded run. mode lets an agent map to its
  // interactive vs headless invocation.
  seedArgs: (prompt: string, mode: TaskMode) => string[];
}
// claude: interactive -> [prompt]; headless -> ["-p", prompt]
// codex:  interactive -> [prompt]; headless -> ["exec", prompt]
```

Persistence — bump the schema and migrate:

```ts
const STORAGE_KEY = "agentdev.workspace.v2"; // was v1
interface Persisted {
  cwd: string;
  slotAgents: Record<string, string>;
  slotCwds: Record<string, string>;
  targets: Record<string, boolean>;
  tasks: Task[];          // NEW
  boardCollapsed: boolean;// NEW
}
```
On load, migrate any `…v1` blob (tasks default `[]`). On load, **normalize**:
any task with `status === "running"` is reset to `backlog` (its process is gone)
and `paneId`/`queued` cleared — live process state is intentionally not restored,
consistent with today's behavior.

## 5. Backend changes

**None required for v1.** `spawn_agent` already accepts and forwards `args`
(`lib.rs:61,94`), and exit is already emitted via `agent-exit` (`lib.rs:138`).
The only frontend-visible backend contract we rely on is "args reach the process"
— already true.

(Future, out of scope: a structured "task complete" signal from headless runs
beyond plain process exit; not needed now.)

## 6. Phased build

Each phase is independently shippable and leaves the app working.

### Phase 0 — Plumb an initial prompt through `start()` (small, enabling)
- Change `AgentPaneHandle.start` to `start(opts?: { initialArgs?: string[] }): Promise<void>` (`AgentPane.tsx:31`).
- In `AgentPane.start` (`AgentPane.tsx:203`), pass `args: opts?.initialArgs ?? []` into `spawn_agent` instead of the hardcoded `[]` (`AgentPane.tsx:214`).
- No call sites change behavior (default `[]`), so this is a safe refactor.
- **Done when:** existing Start/Start-all still work; a manual `ref.start({ initialArgs: ["echo", "hi"] })` is observable.

### Phase 1 — Task model + state + persistence (no UI yet)
- Add `Task` types and `seedArgs` to the agent catalog (§4).
- Add `tasks` state + `boardCollapsed` to `App.tsx`; include in the persistence `useEffect` (`App.tsx:75`).
- Add the v1→v2 migration + running→backlog normalization in `loadPersisted` (`App.tsx:48`).
- CRUD helpers: `addTask`, `updateTask`, `deleteTask`, `moveTask(id, status)`.
- **Done when:** tasks survive reload; running tasks come back as backlog.

### Phase 2 — Board UI: manage cards (no launching)
- New `src/TaskBoard.tsx` + `src/TaskBoard.css` (GitHub-dark, matches existing tokens).
- Collapsible left rail; four columns with counts; `TaskCard` (title, agent chip in agent accent, prompt preview, dir badge if overridden).
- "New task" composer: title, prompt (textarea), agent `<select>` reusing `AGENTS`, optional dir via the same `open({directory:true})` dialog used in `App.browse` (`App.tsx:114`), mode toggle.
- Native DnD between columns calls `moveTask`; ◀ ▶ buttons as keyboard fallback.
- Update `App` grid/CSS to `topbar / [rail | workspace] / broadcast`.
- **Done when:** you can create, edit, drag, and delete cards; nothing launches yet.

### Phase 3 — Launch a task into a pane (core wiring)
- Add `paneTask: Record<slotId, taskId | null>` to `App`.
- `startTask(taskId)`: pick first free pane (status `idle`/`exited`, no bound task);
  if none → set `queued`, surface notice, return. Else: bind `paneTask`, set the
  pane's agent to `task.agentId` (reuse `changeAgent`, `App.tsx:96`), set its dir
  if `task.cwd`, compute `args = agent.seedArgs(task.prompt, task.mode)`, call
  `refs.current[slot].start({ initialArgs: args })`, set task `running` + `paneId`.
- Trigger from a card ▶ button and from dropping a card onto the Running column.
- Pane header shows a small badge with the bound task title (`AgentPane` new optional prop `taskLabel`).
- **Done when:** ▶ on a Backlog card boots the agent in a pane with the prompt pre-filled; card moves to Running.

### Phase 4 — Lifecycle sync + auto-advance
- Centralize status handling: in `App`'s `onStatusChange` (`App.tsx:199`), detect a
  transition to `exited` for a slot with a bound task. If that task is `headless`,
  `moveTask(task, "review")` and clear the binding; if `interactive`, leave it
  `running` (manual advance) but mark the pane reusable.
- Stopping a pane or dragging a card out of Running clears `paneTask` and, if the
  pane is still running that task, calls `ref.stop()`.
- Card actions: Re-run (re-launch into a free pane), Focus pane, Move to Review/Done.
- When a pane frees up, if any card is `queued`, auto-start the oldest.
- **Done when:** headless tasks auto-advance on completion; interactive tasks are advanced by hand; queued cards drain as panes free.

### Phase 5 — Polish & edges
- Empty-column states, per-column counts, collapsed-rail icon strip.
- a11y: ensure move buttons + composer have labels (matches the existing audit posture in memory); focus management on card create.
- Persist `boardCollapsed`; restart notice for normalized running→backlog cards.
- Optional: badge the Start-all / broadcast targets to note panes bound to tasks.
- **Done when:** keyboard-only operation works; layout holds at small widths.

## 7. Files touched

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | none (v1) |
| `src/AgentPane.tsx` | `start(opts?)` signature; forward `initialArgs`; optional `taskLabel` badge |
| `src/App.tsx` | task state, persistence v2 + migration, `startTask`/scheduler, `paneTask`, status→advance logic, render the rail |
| `src/TaskBoard.tsx` (new) | board rail, columns, cards, composer, DnD |
| `src/TaskBoard.css` (new) | board styling in existing dark tokens |
| `src/App.css` | grid change to `[rail | workspace]`; rail collapse |
| `src/icons.tsx` | a few icons (plus/card/columns) if not present |
| `README.md` | document the board + interactive/headless modes |

## 8. Risks & mitigations
- **Seed-prompt arg correctness per agent.** Verify the exact flags by launching
  `claude`/`codex` manually before wiring (D1). Keep it in `seedArgs` so fixes are one-line.
- **Interactive agents never "exit."** Handled by D2 — auto-advance is gated on `mode === "headless"`; interactive cards are advanced manually.
- **All panes busy.** Handled by D3 queue; no silent drops.
- **Prompt escaping.** Args go through `CommandBuilder::arg` (`lib.rs:94`), which does
  not shell-split, so quotes/spaces in prompts are safe — no shell injection surface.
- **Schema migration.** Guard the v1→v2 read; never throw on a missing/garbled blob (current `loadPersisted` already try/catches, `App.tsx:48`).

## 9. Future (sets up BridgeSwarm)
The board is the substrate the swarm needs. Once cards + columns + a scheduler
exist, Phase 2 of the broader roadmap can add: roles per card (builder/reviewer),
a coordinator that creates and assigns cards, and a shared "mailbox" surfaced as a
column or side feed. None of that is buildable without the task model defined here,
which is why this is the right next big feature.
