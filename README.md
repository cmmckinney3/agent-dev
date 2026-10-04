# Crucible

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
- **Projects** — a named project carries its folder, Git branch, preferred
  agents, tasks and pane layout. Switch projects from the header; sessions running
  in another project keep running.
- **Working directory** — panes inherit the project folder unless a pane (or a
  task) overrides it.
- **Focus mode** — expand one pane to the full workspace and come back to the
  previous layout without losing terminal state.
- **Start idle / Stop** — starts only panes that aren't already working, so it can
  never kill a live agent. Restarting a pane stays an explicit, per-pane action.
- **Broadcast composer** — send one prompt to the selected _running_ panes and see
  a per-pane delivery result; a failed message keeps its draft.
- **Task review** — a task opens onto its request, run attempts, saved terminal
  output and the Git diff captured against a baseline taken at launch, plus review
  notes. Runs survive a restart; exit code 0 means the process finished, not that
  the work is correct.
- **Agent review & change requests** — hand a finished task to a second agent for
  a read-only review, or send **Request changes** feedback that the task's next
  run receives along with the original request. When a review finishes, its
  `APPROVE` / `REQUEST CHANGES` verdict is read from the output and shown on the
  reviewed task; **Use as change request** puts the reviewer's findings into the
  Request changes form for you to edit and send.
- **Teammates** — saved, named agents with a brief and a memory of their own.
  Pick one under "Who does it" when you create a task: the run is told who it is
  and where its memory file is, reads it before it starts and adds what it
  learns, and Crucible folds the notes back in when the run ends. Memory belongs
  to the teammate, not the project, so lessons from one project reach the next.
  Read, edit or clear it on the **Teammates** page.
- **Teammate messages** — a teammate can write to the others (a lesson that
  applies to their stack, a question, a request) in an outbox file its run is
  given. Crucible delivers the message when the teammate finishes a turn, and
  the recipient reads it at the start of its next task. Set a teammate to
  **Start a task** and a message starts a headless task for it in the sender's
  folder, up to a chain limit, so two teammates can't keep waking each other.
  You can write to a teammate too, and every message is on its **Messages** tab.
- **Agent status & Dashboard** — every running pane says what its agent is
  doing: _Working_, _Needs you_ (blocked on an approval prompt, a bell or an OSC 9
  request, with the question shown), _Done_ (finished a turn you have not looked
  at) or _Idle_. The **Dashboard** (`Ctrl Shift D`) lists every session in every
  project grouped that way, with time in state; click one to jump to it. Desktop
  notifications for _Needs you_ and _Done_ are on while Crucible is in the
  background. Detection reads the terminal stream, so it works for any CLI, but
  it is a heuristic: a prompt worded unlike any known one shows as Done or Idle.
- **Command palette** — `Ctrl Shift P` for projects, tasks, sessions and actions.
- **Activity page** — searchable, paginated run history. Run counts and outcomes
  only; it is not token, cost or quota tracking.
- **Settings page** — a third page: which agents are available, OpenRouter
  credentials, terminal appearance, task-board behaviour, and stored data.
  See [Settings](#settings) below.

## Activity

The **Activity** button next to the brand switches to a page that shows how much
each agent in the catalog actually gets used. Every launch — a pane's Start
button, Start idle, or a task card — is recorded automatically:

- **Summary tiles** — runs, total session time, how many agents are live right
  now, and how many catalog agents have been used in the selected range.
- **Per-agent cards** — one per catalog agent (agents deleted from the catalog
  keep their history, flagged _removed_): run count, total and average session
  time, last active, task vs manual launches, outcome counts
  (`ok` / `failed` / `stopped` / `interrupted`), and each agent's share of
  session time.
- **Run history** — every retained run with session, origin task, start time,
  duration (live runs tick up), and outcome, searchable and paginated, each row
  linking to its saved output and task. Runs that were live when the app closed
  come back as _interrupted_, since their durations are unknowable.
- **Time range** — filter everything to the last 24 h / 7 d / 30 d or all time.

"Session time" is wall-clock time an agent's process was running in a pane —
the app can't see tokens or API cost for arbitrary CLIs. History persists with
the workspace (last 500 runs, oldest dropped); **Clear history** wipes finished
records. There is no token, cost or quota tracking: nothing reports it for an
arbitrary CLI, and no figure is ever estimated from duration.
Switching pages never touches running sessions: terminals live outside the React
tree, so processes carry on untouched.

## Task board

The board turns Crucible from "parallel terminals" into an agentic workflow:

- **Create cards** — title, prompt, agent, an optional per-task working dir, and a
  run **mode**. The prompt seeds the agent as a launch argument (not typed in), so
  there's no race with the TUI starting up.
- **Interactive vs headless** —
  - _Interactive_ (default): the agent launches seeded with the prompt and keeps
    running so you can watch and steer. The card sits in **Running**; you advance
    it to Review/Done by hand.
  - _Headless_: the agent runs in print/exec mode and exits when done; the card
    then **auto-advances** Running → Review carrying the process **exit code**,
    shown as an `ok` / `exit N` badge so failures are visible at a glance.
- **Launch & scheduling** — "Run" (or dropping a card on Running) picks the first
  free pane. If every pane is busy, the card stays in Backlog flagged _queued_ and
  starts automatically when a pane frees up (or when you split a new pane open).
- **Move cards** — drag between columns, or use the ◀ ▶ buttons (keyboard-friendly
  fallback). Each running card can **Focus** its pane; finished cards can **Re-run**.
- **Request changes** — in a task's detail, write what needs to change and send it
  back (optionally re-running it at once). The feedback is stored on the task and
  sent after the original request on every launch until the task is marked
  reviewed & done or the request is cleared. The run's history record keeps the
  exact prompt that was sent.
- **Agent review** — **Ask for review** in task detail creates a linked headless
  `Review: <title>` task in the same folder, run by the agent you pick (a
  different one from the builder by default). It reports findings without editing
  files. The reviewer prompt names the request, the changed files and the exit
  code, but never embeds the diff or the agent's output.
- **Persistence** — tasks survive restarts. Live process state does not, so any
  card that was Running comes back in Backlog (a one-time notice explains this).

## Agent catalog

The **Agents** button in the top bar manages the catalog that panes and task
cards draw from. Each agent is:

- **Name** and **program** — the executable on your `PATH` (npm `.cmd` shims
  are resolved automatically on Windows).
- **Accent color** — used on pane headers, cards, and broadcast chips.
- **Launch args** per mode — one template for _interactive_, one for
  _headless_. `{prompt}` marks where the task prompt is inserted; quote an arg
  to keep spaces together (args go straight to the process, no shell, so the
  prompt itself never needs escaping). Defaults: `claude "<prompt>"` /
  `claude -p "<prompt>"`, `codex "<prompt>"` / `codex exec "<prompt>"`.

- **Model access** — either the CLI's own authentication, or **OpenRouter**,
  which pulls the key, base URL and model from Settings → Providers.
- **Model** — a per-agent override for the OpenRouter default.
- **Environment** — `KEY=value` per line, set on the agent's process.
  `{openrouter_key}`, `{openrouter_base}` and `{openrouter_model}` are
  substituted at launch, in the env _and_ in the launch args; anything that
  resolves to nothing is left unset rather than exported blank.

**New agent** offers templates as starting points, including OpenRouter wiring
for OpenAI-compatible CLIs, Aider and OpenCode. Which environment variables a
given CLI actually reads is up to that CLI — the templates are a head start, and
every field stays editable.

The catalog persists with the workspace. Deleting an agent remaps any pane or
card that referenced it, and the last agent can't be deleted. Switching one
**off** (Settings → Agents) does the same remap but keeps the configuration and
its run history.

## Settings

The **Settings** button in the top bar opens a page of options that all change
real behaviour:

- **Agents** — a switch per catalog entry. Off hides it from pane pickers and
  the task composer without deleting it. An agent with a live session, and the
  last one left on, can't be switched off.
- **Providers — OpenRouter** — master switch, API key (with a live key check),
  base URL, and a default model (the model list can be fetched from OpenRouter).
  The key is stored in plain text with the rest of the workspace on this machine.
- **Terminal** — font size and family, scrollback, cursor style and blink, and
  copy-on-select. Applied live to panes that are already running.
- **Task board** — whether teammate messages may start tasks and how long a
  chain of them may get, auto-start queued cards, a cap on concurrent task runs, what
  a finished headless run does (Review / Done on exit 0 / stay put), whether
  deleting a card asks first, and the review instructions appended to every
  agent-review prompt (blank uses the built-in checklist).
- **Workspace** — taskbar attention when a run finishes, desktop
  notifications (off, while Crucible is in the background, or always), whether
  **Stop all** asks first, and whether a broadcast presses Enter or just types
  the text into each pane.
- **History & data** — record runs or not, how many to keep, clear the history,
  copy the whole workspace as a JSON backup, restore one, or reset everything.

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

Checks:

```bash
npm test               # Node suite: workspace/persistence/session models
npm run build          # typecheck + production build
cd src-tauri && cargo test --offline
```

### Releasing a new installer

Bump `version` to the same value in `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and `package.json` before building, or the MSI will not
upgrade the installed copy — Windows compares only `major.minor.build` and ignores
a fourth field. The WiX `upgradeCode` is pinned in `tauri.conf.json` and must never
change; neither may `identifier`, which owns the data directory and the WebView2
profile holding any pre-native-storage workspace. `npx tauri inspect
wix-upgrade-code` prints both the derived and the pinned value.

## How it's wired

- `src-tauri/src/lib.rs` — PTY session manager. Commands: `spawn_agent`,
  `write_to_agent`, `resize_agent`, `kill_agent`, `wait_for_saves`. A reader thread
  per agent streams PTY bytes to the frontend as base64 `agent-output` events; on
  EOF the child is reaped and `agent-exit` reports its exit code.
- `src-tauri/src/desktop.rs` — everything else the desktop owns: atomic workspace
  storage with a last-known-good backup, the DPAPI-encrypted credential vault,
  `project_info`, agent installation checks, saved run output, Git baseline/diff
  capture, Git worktrees, backup import/export and window state.
- `src/sessions.ts` — the live-session registry. Terminals live here, outside
  React, so they survive page changes, project switches and remounts.
- `src/AgentPane.tsx` — the view for one pane: mounts its terminal, renders the
  header, find bar and overflow menu.
- `src/teammates.ts` / `src/TeammatesPage.tsx` — the pure teammate model
  (prompt preface, the run's folder, the merge of a run's notes) and the
  Teammates page. `seed_teammate_run` / `collect_teammate_run` in `desktop.rs` set
  up a run's `.crucible/<name>-<run>/` folder (memory, inbox, outbox) and read it
  back.
- `src/messages.ts` — the pure messaging model: reading an outbox, building an
  inbox, when a message starts a task, and the chain limit.
- `src/activity.ts` / `src/Dashboard.tsx` — the pure agent-activity model
  (Working / Needs you / Done / Idle, inferred from the terminal stream) and the
  Dashboard that groups every session by it. `src/desktopNotify.ts` sends the
  desktop notifications.
- `src/storage.ts` / `src/workspace.ts` — the persistence funnel (debounced,
  serialized, failures always surfaced with a retry) and the `Workspace` model
  whose `normalizeWorkspace()` validates every untrusted blob before it can
  replace live state.
- `src/App.tsx` — the workspace shell: top bar, the pane columns and their
  resize dividers, broadcast bar, task + catalog state, the scheduler, and
  persistence.
- `src/layout.ts` — the split-layout model: columns of stacked panes with
  fr-style size weights, split/close/resize operations, and the presets.
- `src/agents.ts` / `src/AgentManager.tsx` — the agent-catalog model (seed-arg
  templates, defaults, persistence normalization) and the manager dialog.
- `src/TaskBoard.tsx` / `src/tasks.ts` — the board rail (columns, cards, composer,
  drag-and-drop) and the task data model.
- `src/review.ts` — the pure reviewer-prompt/review-task model: builds the prompt
  an agent reviewer gets, the linked `Review: <title>` task, the default reviewer
  choice and a task's list of reviews.
- `src/settings.ts` / `src/SettingsPage.tsx` — the settings model (defaults and
  per-field normalization) and the Settings page. App owns the state and wires
  each field to the behaviour it controls.
- `src/UsagePage.tsx` / `src/usage.ts` — the Activity page and the run-history
  model behind it (RunRecord log, normalization, per-agent aggregation).
  Recording hooks into App's status funnel: a launch opens a record (task
  launches pass their attribution through `start()`, the same race-avoidance
  as program/cwd), and exit/stop closes it.

## Roadmap ideas

- Real orchestration, still open: a coordinator that creates and assigns
  cards. The builder/reviewer handoff exists as [Agent review](#task-board),
  per-agent status as the Dashboard, and agents can message each other as
  teammates. Direction and research: `docs/bridgemind-research.md`; next
  phases: `docs/agent-status-plan.md`.
