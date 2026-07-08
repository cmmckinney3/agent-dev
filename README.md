# AgentDev

A personal, BridgeSpace-style agent development environment. It runs interactive
CLI coding agents side by side in one desktop window, each in its own real
terminal, so you can drive several agents in parallel against the same project —
and a Kanban **task board** to launch and track that work.

Built with **Tauri (Rust) + React + TypeScript + xterm.js**.

## What it does (v1)

- **A splittable pane workspace (up to 8)** — each pane runs any agent from the
  catalog, switchable while idle. Each is a full pseudo-terminal (ConPTY on
  Windows via `portable-pty`), so the agents' interactive TUIs render and
  respond normally. Split any pane right (new column) or down (stacked in the
  column), close panes you don't need, and drag the dividers to resize —
  double-click a divider to even a pair out. The preset buttons in the top bar
  (3 cols, main + stack, 2 + 1, 2×2) are quick arrangements on top of this; the
  layout, including sizes, persists across restarts.
- **Configurable agent catalog** — ships with **Claude Code** (`claude`) and
  **Codex** (`codex`); the **Agents** button in the top bar opens a manager to
  add, edit, or remove agents (name, program, accent color, and per-mode launch
  args). Any CLI agent on your `PATH` can be plugged in. See
  [Agent catalog](#agent-catalog) below.
- **Task board** — a collapsible left rail with four columns
  (Backlog → Running → Review → Done). Write a task card, then launch it: the
  card's agent spawns into a free pane **already seeded with the task prompt**.
  See [Task board](#task-board) below.
- **Working directory** — set a project path in the top bar; panes inherit it
  unless a pane (or a task) overrides it. Leave it blank to use the app's default.
- **Start all / Stop all** — launch or kill every agent at once. Each pane also
  has its own Start/Restart and Stop buttons.
- **Broadcast bar** — type one prompt and send it to every selected pane at once.

## Task board

The board turns AgentDev from "parallel terminals" into an agentic workflow:

- **Create cards** — title, prompt, agent, an optional per-task working dir, and a
  run **mode**. The prompt seeds the agent as a launch argument (not typed in), so
  there's no race with the TUI starting up.
- **Interactive vs headless** —
  - *Interactive* (default): the agent launches seeded with the prompt and keeps
    running so you can watch and steer. The card sits in **Running**; you advance
    it to Review/Done by hand.
  - *Headless*: the agent runs in print/exec mode and exits when done; the card
    then **auto-advances** Running → Review carrying the process **exit code**,
    shown as an `ok` / `exit N` badge so failures are visible at a glance.
- **Launch & scheduling** — "Run" (or dropping a card on Running) picks the first
  free pane. If every pane is busy, the card stays in Backlog flagged *queued* and
  starts automatically when a pane frees up (or when you split a new pane open).
- **Move cards** — drag between columns, or use the ◀ ▶ buttons (keyboard-friendly
  fallback). Each running card can **Focus** its pane; finished cards can **Re-run**.
- **Persistence** — tasks survive restarts. Live process state does not, so any
  card that was Running comes back in Backlog (a one-time notice explains this).

## Agent catalog

The **Agents** button in the top bar manages the catalog that panes and task
cards draw from. Each agent is:

- **Name** and **program** — the executable on your `PATH` (npm `.cmd` shims
  are resolved automatically on Windows).
- **Accent color** — used on pane headers, cards, and broadcast chips.
- **Launch args** per mode — one template for *interactive*, one for
  *headless*. `{prompt}` marks where the task prompt is inserted; quote an arg
  to keep spaces together (args go straight to the process, no shell, so the
  prompt itself never needs escaping). Defaults: `claude "<prompt>"` /
  `claude -p "<prompt>"`, `codex "<prompt>"` / `codex exec "<prompt>"`.

The catalog persists with the workspace. Deleting an agent remaps any pane or
card that referenced it, and the last agent can't be deleted.

## Requirements

- The `claude` and `codex` CLIs installed and on your `PATH`, already logged in
  with your Claude and ChatGPT subscriptions.
- Node.js + Rust toolchain (for development).

## Run it

```bash
npm install
npm run tauri dev      # dev window with hot reload
npm run tauri build    # produce a standalone installer
```

## How it's wired

- `src-tauri/src/lib.rs` — PTY session manager. Commands: `spawn_agent`,
  `write_to_agent`, `resize_agent`, `kill_agent`. A reader thread per agent
  streams PTY bytes to the frontend as base64 `agent-output` events; on EOF the
  child is reaped and `agent-exit` reports its exit code.
- `src/AgentPane.tsx` — one xterm.js terminal bound to one agent: renders output,
  forwards keystrokes, keeps the PTY sized to the pane. `start({ initialArgs })`
  seeds a launch with the task prompt.
- `src/App.tsx` — the workspace shell: top bar, the pane columns and their
  resize dividers, broadcast bar, task + catalog state, the scheduler, and
  persistence.
- `src/layout.ts` — the split-layout model: columns of stacked panes with
  fr-style size weights, split/close/resize operations, and the presets.
- `src/agents.ts` / `src/AgentManager.tsx` — the agent-catalog model (seed-arg
  templates, defaults, persistence normalization) and the manager dialog.
- `src/TaskBoard.tsx` / `src/tasks.ts` — the board rail (columns, cards, composer,
  drag-and-drop) and the task data model.

## Roadmap ideas

- Real orchestration: roles (builder/reviewer), a coordinator that creates and
  assigns cards, and a mailbox/shared feed between agents.
- Session history.
