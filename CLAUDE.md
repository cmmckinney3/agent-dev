# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Crucible: a personal desktop app that runs multiple interactive CLI coding agents
(Claude Code, Codex, or any CLI on `PATH`) side by side, each in its own real
pseudo-terminal, plus a Kanban task board that launches agents with a seeded
prompt and tracks them through Backlog → Running → Review → Done. Work is
organized into **projects** (name, folder, preferred agents, saved layout), and a
completed run keeps its saved output and Git diff so it can be reviewed after a
restart. Three pages share the shell: Workspace (panes + board), Activity
(per-run history), and Settings.

Stack: **Tauri 2 (Rust) + React 19 + TypeScript + xterm.js**, no backend server, no
external state library — app state lives in `src/App.tsx`, persisted through the
Rust side rather than `localStorage`.

## Commands

```bash
npm install             # install JS deps
npm run tauri dev       # full app, dev window with hot reload (spawns vite + rust)
npm run dev              # vite only — serves the frontend at :1420 without the Tauri shell
npm run build            # tsc --noEmit-equivalent typecheck + vite production build
npm run tauri build      # produce a standalone installer
```

- `npm test` runs the Node test suite (`node --test tests/*.test.mjs`). It has no
  browser runtime: the tests transpile the pure TS modules with `typescript` and
  stub the native bridge, so anything worth pinning belongs in a pure module
  (`workspace.ts`, `tasks.ts`, `layout.ts`, `sessions.ts`, `storage.ts`) rather
  than inside a component.
- There is **no lint config**. `npm run build`'s `tsc` step (strict mode,
  `noUnusedLocals`/`noUnusedParameters`) is the other frontend safety net — run it
  after any non-trivial TS edit.
- For Rust changes, `cargo test --offline` from `src-tauri/` runs the storage,
  credential-vault, review/worktree and PTY regression tests. The DPAPI tests need
  a real Windows user profile, so run them outside a restricted sandbox.
- Format changed files with `npm exec --yes --package=prettier@3.6.2 -- prettier
--write <files>` and `cargo fmt`.
- Vite dev server is pinned to port `1420` (`strictPort: true` in `vite.config.ts`)
  because `tauri.conf.json` expects it there; don't change the port without updating
  both files.
- `dist/` and `src-tauri/target/` are build output — never edit by hand.

## Architecture

**Backend is two files.** `src-tauri/src/lib.rs` is the PTY session manager
(`spawn_agent`, `write_to_agent`, `resize_agent`, `kill_agent`, `wait_for_saves`);
`src-tauri/src/desktop.rs` is everything else the desktop owns — `load_workspace`,
`save_workspace`, `project_info`, `check_agent`, `read_run`, `create_worktree`,
`export_backup`, `import_backup`, `save_window_state`.
Each spawn opens a `portable-pty` pseudo-terminal, resolves the program (a Windows npm
cmd-shim is launched as `node <script>` directly, since `cmd.exe` would reparse the
prompt; any other `.cmd`/`.bat` goes through `cmd.exe /c` and refuses a prompt holding
`"`, `%`, `!`, `^`, `&`, `|`, `<`, `>` or a line break), applies the optional `env` map
the frontend sends (already token-resolved; empty values are dropped there, so nothing
is exported blank), and starts a reader thread that streams output to the frontend as
base64 `agent-output` events. On EOF the child is
reaped and an `agent-exit` event carries its exit code. Each session is tagged with
a monotonic `epoch` so that restarting a pane (which replaces its session) can't let
a stale reader thread report a spurious exit for the new one. Args are passed via
`CommandBuilder::arg` (no shell), so prompts containing quotes/spaces are never a
shell-injection concern.

**Frontend state lives in `App.tsx`** — there's no Redux/Zustand/Context store.
Everything (projects and their pane layouts, tasks, agent catalog, settings, run
history, broadcast targets) is `useState` in `App` and passed down as props.

**Terminals live outside React.** `src/sessions.ts` owns a module-level map of
live sessions keyed by a globally unique pane id, so a session survives page
changes, project switches and component remounts. Panes call into it rather than
owning terminal state; `startSession` refuses to replace a live process, a stop
during launch waits for the launch to finish, and delivery failures reject instead
of being swallowed. Never route terminal lifecycle through component state.

**Persistence and migration:** `normalizeWorkspace()` in `src/workspace.ts` is the
single gate for untrusted data — disk, backup file, or legacy `localStorage` blob.
`STORAGE_KEY` is versioned (currently `agentdev.workspace.v7`) with `LEGACY_KEYS`
as the migration chain; bump the key and extend that chain when the `Workspace`
shape changes. Pass `strict = true` when importing a backup so a malformed file is
rejected _before_ it replaces live state. On every load, any task left `"running"`
(impossible to have survived a restart, since PTY sessions don't) is reset to
`backlog`, marked `interrupted`, and its pane binding cleared.

**Storage is native and atomic.** `src/storage.ts` is the only persistence funnel:
it debounces, serializes saves onto one chain, and reports failures through
`onStorageError` so "Changes could not be saved" is always visible with a retry.
On the Rust side `atomic_write` writes a temp file and replaces, keeping
`workspace.backup.json` as the last known good copy; a corrupt primary falls back
to it and reports `recovered`. Secrets (the OpenRouter key and every agent `env`
value) live in a separate DPAPI-encrypted `vault-*.bin`, never in the plaintext
store, and a vault that cannot be unlocked is reported on its own rather than
failing the whole load. Portable backups are redacted by default.

**Key modules and what they own:**

- `src/layout.ts` — pure, backend-free split-layout model: a row of `PaneColumn`s
  each stacking `PaneSlot`s, with fr-style size weights. Split/close/move/resize
  operations and the layout presets all live here; `App.tsx` only calls into it.
- `src/sessions.ts` — the session registry described above: `startSession`,
  `stopSession`, `sendSession`, `focusSession`, `disposeSession`, `sessionState`,
  `sessionRun`, `subscribeSessions`. Pure enough to unit-test against a stubbed
  native bridge, and where every terminal-lifecycle rule belongs.
- `src/AgentPane.tsx` — the view for one pane: it mounts the terminal owned by
  `sessions.ts`, renders the 68px two-row header, the find bar, and the overflow
  menu (which flips above the trigger when a short window leaves no room below).
  It holds no session state of its own.
- `src/agents.ts` — the agent catalog model. An `AgentConfig` carries
  `interactiveArgs`/`headlessArgs` templates with a `{prompt}` (`PROMPT_TOKEN`)
  placeholder; `seedArgs()` fills it in per launch mode. It also carries
  `enabled` (off = hidden from pane pickers and the composer, config kept),
  `provider` (`native` or `openrouter`), a per-agent `model`, and an `env` map.
  `resolveTokens()` substitutes `{openrouter_key}`/`{openrouter_base}`/
  `{openrouter_model}` into args and env; `launchEnv()` produces the process
  environment and `launchBlockReason()` says why an agent can't run (switched
  off, provider disabled, no key, no model). `normalizeAgents()`
  migrates/validates a persisted catalog against `DEFAULT_AGENTS` (Claude Code,
  Codex) so a schema change never bricks a stored workspace, and guarantees at
  least one enabled entry. `AGENT_TEMPLATES` seeds the manager's "New agent"
  menu. Any CLI on `PATH` can be added here without a rebuild — this is what
  makes the catalog "pluggable."
- `src/AgentManager.tsx` — the catalog editor dialog (add/edit/delete agents,
  provider/model/env, template picker). Enabling and disabling lives in Settings.
- `src/settings.ts` — the `Settings` model (terminal, task board, workspace,
  history retention, OpenRouter credentials) with `DEFAULT_SETTINGS` and a
  per-field `normalizeSettings()`. Every field must drive real behaviour — don't
  add a knob here without wiring it.
- `src/SettingsPage.tsx` — the Settings page: agent on/off roster, OpenRouter
  provider setup (key check and model list are live `fetch`es to openrouter.ai),
  terminal, task board, workspace and data sections. Pure presentation; it
  reports `Partial<Settings>` patches to App.
- `src/usage.ts` / `src/UsagePage.tsx` — the run-history model and the Activity
  page (searchable and paginated). App records a `RunRecord` per launch;
  `MAX_RUN_RECORDS` is the ceiling and `settings.usageLimit` the effective
  retention. This is run counts and outcomes, **not** token or cost tracking —
  never present invented quota or cost figures.
- `src/tasks.ts` — pure `Task`/`TaskStatus`/`TaskMode` data model for the board,
  the column order, and `draftFromTask()`. Use that helper for every draft and
  template: a `Task` also carries runtime state (status, paneId, queued, worktree,
  review notes) and spreading a whole task into a draft lets a stale snapshot
  revert the live record or smuggle its `id` into a new task. `launchPrompt(task)`
  is the prompt every launch sends (the request plus any pending `changeRequest`):
  launch paths must use it, never `task.prompt` directly.
- `src/review.ts` — pure (no React, no Tauri) model for agent review.
  `buildReviewPrompt` builds the reviewer prompt, `reviewTaskFor` the linked
  headless `Review: <title>` task (`reviewOf` points at the reviewed task),
  `pickReviewer` the default reviewer (an enabled agent other than the builder when
  one exists) and `reviewsOf` a task's non-archived reviews. **Argv safety rule:**
  the prompt never embeds diff text or agent output — only fixed text, the user's
  request/change request, file paths (control characters stripped, length capped),
  status words and an exit code. Prompts travel as argv (32 KiB on Windows), and a
  non-npm batch agent still goes through `cmd.exe /c`, which refuses the characters
  a diff is full of.
- `src/workspace.ts` — the `Project`/`Workspace`/`PromptTemplate` model plus
  `normalizeWorkspace`, `redactWorkspace`, `retainRuns`, `taskBlocker`,
  `queueCandidates` and `hasDependencyCycle`. Pure, and the most heavily tested
  module — put new persistence or queue rules here, not in a component.
- `src/storage.ts` — load/save funnel (see "Storage is native and atomic").
- `src/TaskBoard.tsx` — the Kanban rail UI: columns, cards, native HTML5
  drag-and-drop (plus ◀ ▶ button fallback since native DnD isn't
  keyboard-accessible). `src/TaskComposer.tsx` is the task dialog and
  `src/TaskDetail.tsx` the review surface; `src/RunReview.tsx` renders a run's
  saved output and Git diff.
- `src/icons.tsx` — hand-rolled inline SVG icons (Lucide-style, 24x24,
  `currentColor`). No icon font, no emoji.

**Task scheduling (in `App.tsx`):** `startTask` picks the first pane that's idle and
unbound (`freeSlot`); if none is free the card is flagged `queued` and a `useEffect`
drains the queue whenever a pane frees up. `mode` (`interactive` vs `headless`)
controls what happens on process exit (`handleStatusChange`): headless auto-advances
carrying the exit code as an `ok`/`exit N` badge — to Review, or to Done on exit 0,
or nowhere, per `settings.headlessCompletion`; interactive always stays in Running
for the human to advance by hand. `settings.autoStartQueued` gates the drain and
`settings.maxConcurrentRuns` caps simultaneous task runs below the pane count.
A task whose `dependencies` aren't all `done` is not refused — it is marked
`queued` and the drain starts it when they finish (`taskBlocker` /
`queueCandidates` in `workspace.ts`). Agent-review tasks (`reviewOf`) are ordinary
headless tasks that run in the reviewed task's folder with `isolation: false`, so
they see the builder's files rather than a fresh worktree. The seed prompt is
delivered as a CLI arg, not typed into the terminal, which avoids racing the CLI's
TUI initialization.

## Releasing (Windows MSI)

Three values decide whether an installer upgrades the existing app or installs a
second copy beside it. Changing any of them carelessly strands the user's data.

- **`version`** must increase for the MSI to upgrade in place. Keep it identical in
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json` (the Tauri
  bundle reads the first, falling back to Cargo.toml). Windows Installer compares
  only `major.minor.build` and **ignores a fourth field**, so `0.2.0.1` does not
  upgrade `0.2.0` — bump one of the first three. Maxima: major and minor 255, the
  rest 65535.
- **`bundle.windows.wix.upgradeCode`** is pinned to
  `610622ce-d978-5ceb-9b2f-cac4368caaa2`. Tauri otherwise derives it from
  `uuid5(DNS, "<productName>.exe.app.x64")`, so renaming the product would change
  it and Windows would treat the build as an unrelated app — two entries in Apps &
  Features. It is pinned to the value the currently installed build already uses,
  so it must **never** change. Check with `npx tauri inspect wix-upgrade-code`.
- **`identifier`** (`com.admin.crucible`) picks the data directory _and_ the
  WebView2 profile, which is where a pre-native-storage build kept its workspace in
  `localStorage`. Changing it orphans both. It was already changed once, at the
  rebrand from `com.admin.agent-dev`; do not change it again.

First launch after upgrading from a build older than native storage finds no
`workspace.json`, falls back through `LEGACY_KEYS` to the `localStorage` blob in
that WebView2 profile, migrates it, and saves natively — then clears the legacy
keys. That path only works while the identifier stays the same.

## Docs

- `docs/task-board-plan.md` — original board/scheduling design rationale.
- `docs/premium-experience-audit.md` — the review this rework was built from.
- `docs/development-checkpoint.md` — running record of what is implemented and
  verified, and what still needs a desktop check. Keep it current.

## UI conventions

`src/App.css` and `src/Premium.css` (plus `AgentManager.css` and
`SettingsPage.css`) are a deliberate, hand-built GitHub-dark design system — CSS custom-property tokens (`--bg`, `--surface`,
`--surface-2/3`, `--border`, `--text`/`-muted`/`-dim`, accent colors), a shared
`--focus-ring` token, `prefers-reduced-motion` support, `color-scheme: dark`. Treat
it as the standard to extend, not replace: no icon fonts or emoji (use
`src/icons.tsx`), no gradients/glassmorphism/oversized hero type, no
scale-transform hovers that shift layout — this is a dense desktop tool. Keep
`aria-label`s on icon-only buttons and `:focus-visible` coverage on anything new.

`Premium.css` is imported after `App.css` and carries the current shell, so it
wins on equal specificity — check there first when a rule seems to have no effect.
`src/TaskBoard.css` and `src/UsagePage.css` are **not imported** and style
nothing; don't edit them expecting a visible change.

Any new popover owes the contract `AgentPane`'s overflow menu already implements:
focus the first action on open, arrow/Home/End navigation, Escape and
outside-pointerdown to close, focus back to the trigger, and `aria-expanded` plus
`aria-haspopup` on that trigger. The window minimum is 900×600 — a menu must be
able to scroll or flip rather than lose an item, and anything sized in pixels
(the task rail) needs clamping against the viewport, since `.main-row` clips
overflow.
