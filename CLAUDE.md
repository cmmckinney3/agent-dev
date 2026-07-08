# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgentDev: a personal, BridgeSpace-style desktop app that runs multiple interactive
CLI coding agents (Claude Code, Codex, or any CLI on `PATH`) side by side, each in
its own real pseudo-terminal, plus a Kanban task board that launches agents with a
seeded prompt and tracks them through Backlog → Running → Review → Done.

Stack: **Tauri 2 (Rust) + React 19 + TypeScript + xterm.js**, no backend server, no
external state library — all app state lives in `src/App.tsx`.

## Commands

```bash
npm install             # install JS deps
npm run tauri dev       # full app, dev window with hot reload (spawns vite + rust)
npm run dev              # vite only — serves the frontend at :1420 without the Tauri shell
npm run build            # tsc --noEmit-equivalent typecheck + vite production build
npm run tauri build      # produce a standalone installer
```

- There is **no lint config and no test suite**. `npm run build`'s `tsc` step
  (strict mode, `noUnusedLocals`/`noUnusedParameters`) is the primary safety net for
  frontend changes — run it after any non-trivial TS edit.
- For Rust-only changes, `cargo check` / `cargo build` from `src-tauri/` is the
  equivalent quick feedback loop.
- Vite dev server is pinned to port `1420` (`strictPort: true` in `vite.config.ts`)
  because `tauri.conf.json` expects it there; don't change the port without updating
  both files.
- `dist/` and `src-tauri/target/` are build output — never edit by hand.

## Architecture

**Backend is one file:** `src-tauri/src/lib.rs` is a PTY session manager exposing
four Tauri commands — `spawn_agent`, `write_to_agent`, `resize_agent`, `kill_agent`.
Each spawn opens a `portable-pty` pseudo-terminal, resolves the program (Windows npm
`.cmd`/`.bat` shims are routed through `cmd.exe /c`), and starts a reader thread that
streams output to the frontend as base64 `agent-output` events. On EOF the child is
reaped and an `agent-exit` event carries its exit code. Each session is tagged with
a monotonic `epoch` so that restarting a pane (which replaces its session) can't let
a stale reader thread report a spurious exit for the new one. Args are passed via
`CommandBuilder::arg` (no shell), so prompts containing quotes/spaces are never a
shell-injection concern.

**Frontend state lives entirely in `App.tsx`** — there's no Redux/Zustand/Context
store. Everything (pane layout, per-slot agent/cwd, tasks, agent catalog,
broadcast targets) is `useState` in `App`, persisted to `localStorage` as one JSON
blob on every change, and passed down as props. Imperative access to each terminal
(`start`/`stop`/`send`/`focus`) goes through `refs.current[slotId]`, a map of
`AgentPaneHandle`s — this is how the scheduler and broadcast bar drive panes without
those panes owning shared state.

**Persistence and migration:** `STORAGE_KEY` is versioned (currently
`agentdev.workspace.v5`); `loadPersisted()` in `App.tsx` falls back through
`LEGACY_KEYS` to read older blobs and normalizes/migrates them on load — bump the
key and extend that chain when changing the `Persisted` shape, don't mutate old
blobs in place. On every load, any task left `"running"` (impossible to have
survived a restart, since PTY sessions don't) is reset to `backlog` and its pane
binding cleared; a one-time notice tells the user how many were reset.

**Key modules and what they own:**
- `src/layout.ts` — pure, backend-free split-layout model: a row of `PaneColumn`s
  each stacking `PaneSlot`s, with fr-style size weights. Split/close/move/resize
  operations and the layout presets all live here; `App.tsx` only calls into it.
- `src/AgentPane.tsx` — one xterm.js terminal bound to one PTY session via
  `invoke`/`listen`. Exposes an imperative handle (`start(opts)`, `stop`, `send`,
  `focus`); `start` accepts an optional `program`/`cwd`/`initialArgs` override so a
  task launch doesn't race a same-tick `setState` for the slot's agent/dir.
- `src/agents.ts` — the agent catalog model. An `AgentConfig` carries
  `interactiveArgs`/`headlessArgs` templates with a `{prompt}` (`PROMPT_TOKEN`)
  placeholder; `seedArgs()` fills it in per launch mode. `normalizeAgents()`
  migrates/validates a persisted catalog against `DEFAULT_AGENTS` (Claude Code,
  Codex) so a schema change never bricks a stored workspace. Any CLI on `PATH` can
  be added here without a rebuild — this is what makes the catalog "pluggable."
- `src/AgentManager.tsx` — the catalog editor dialog (add/edit/delete agents).
- `src/tasks.ts` — pure `Task`/`TaskStatus`/`TaskMode` data model for the board;
  no logic, just types and the column order.
- `src/TaskBoard.tsx` — the Kanban rail UI: columns, cards, the composer, native
  HTML5 drag-and-drop (plus ◀ ▶ button fallback since native DnD isn't
  keyboard-accessible).
- `src/icons.tsx` — hand-rolled inline SVG icons (Lucide-style, 24x24,
  `currentColor`). No icon font, no emoji.

**Task scheduling (in `App.tsx`):** `startTask` picks the first pane that's idle and
unbound (`freeSlot`); if none is free the card is flagged `queued` and a `useEffect`
drains the queue whenever a pane frees up. `mode` (`interactive` vs `headless`)
controls what happens on process exit (`handleStatusChange`): headless auto-advances
Running → Review carrying the exit code as an `ok`/`exit N` badge; interactive stays
in Running for the human to advance by hand. This scheduling logic, the seed-prompt
delivery mechanism (CLI arg, not typed injection — avoids a race with the CLI's TUI
initializing), and the phased build plan are documented in more detail in
`docs/task-board-plan.md` if you need the original design rationale.

## UI conventions

`src/App.css` (plus `AgentManager.css`, `TaskBoard.css`) is a deliberate, hand-built
GitHub-dark design system — CSS custom-property tokens (`--bg`, `--surface`,
`--surface-2/3`, `--border`, `--text`/`-muted`/`-dim`, accent colors), a shared
`--focus-ring` token, `prefers-reduced-motion` support, `color-scheme: dark`. Treat
it as the standard to extend, not replace: no icon fonts or emoji (use
`src/icons.tsx`), no gradients/glassmorphism/oversized hero type, no
scale-transform hovers that shift layout — this is a dense desktop tool. Keep
`aria-label`s on icon-only buttons and `:focus-visible` coverage on anything new.
