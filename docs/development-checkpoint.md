# Development checkpoint — September 11, 2026

**Development only: do not replace, install over, or modify the installed Crucible
app.** Resume this working tree; do not reset it. Many files were already modified
before this implementation.

The resume list from the previous checkpoint (September 10) is complete except for
the native desktop verification noted under "Still owed" below. Everything else in
that list was either implemented or verified as already correct.

## Implemented

- Compact desktop shell and pane headers, focus mode, contextual pane menus, resizable task rail, expandable broadcast composer.
- Projects, recent project switching, per-project layouts/folders/agents, saved layouts and new-task drafts.
- Task details, review notes, persisted run output and Git baseline diffs, explicit interruption/review states, manual CLI resume for supported agents.
- Command palette/global search; searchable Activity with filters and pagination.
- Task priorities, queue controls, dependencies, templates, duplication, archive/undo, optional Git worktrees.
- Categorized/searchable Settings, installation checks, native backup dialogs and recovery screen.
- Native atomic workspace storage, Windows DPAPI credential vault, redacted portable backups, visible save errors, bounded recordings, run-retention cleanup.
- Terminal instances live outside React and survive page/project changes. Start idle cannot replace live sessions. Delivery failures reject. Stop during launch waits.
- Windows process reaping runs independently of the ConPTY reader: closing the master after process exit produces EOF.

## Closed in this pass

**Correctness review (was resume item 1).**

- `draftFromTask()` in `src/tasks.ts` is now the only way a draft or template is
  built. Previously the composer spread a whole `Task` into its draft, so saving an
  edit could revert `status`/`paneId` to the values they had when the dialog opened,
  and a template saved from an existing task carried that task's `id` — which
  `saveTask` then used, appending a second task with a duplicate id. `saveTask`
  re-sanitizes as a second line of defence.
- Saving an _edit_ no longer clears the project's unsaved new-task draft.
- Duplicating a task no longer carries the original's `reviewNotes`.
- A task blocked by dependencies is queueable from its card and from task detail
  instead of showing a disabled Run button. `startTask` already queued it correctly;
  only the UI refused. It now says so via a toast.
- Restoring a saved layout now refuses reserved panes (a launch in flight), not just
  running ones, and disposes the sessions of panes the restore drops — it previously
  leaked them. This matches what `preset()` and `closePane()` already did.
- Focus mode ignores a stale pane id. A `expanded` pointing at a pane no longer in
  the layout used to hide every column and blank the workspace.
- The broadcast delivery result is cleared when the message is edited, so a stale
  "Delivered to 3 terminals" cannot sit under a new draft.

**Git capture diagnostics (was resume item 2).** `git_output` in
`src-tauri/src/desktop.rs` keeps Git's exit status and stderr; `git_missing_repo` /
`git_capture_warning` separate "there is no repository here" (ordinary, generic
notice) from a real refusal such as `detected dubious ownership`, whose own text is
collapsed to one line, truncated to 300 chars and preserved in the review warnings.
`Snapshot.git_error` is `#[serde(default)]` so pre-existing baselines still load.
`git diff --no-index` failures are no longer swallowed as an empty diff.
`project_info` carries the same diagnostic as `gitError`, and the workspace header
shows "Git unavailable" plus the reason and a **Check again** action rather than
implying the folder is not a repository.

**Menu placement, keyboard and small windows (was resume item 3).**

- The pane overflow menu flips above its trigger when the window leaves no room
  below, and has `max-height: min(60vh, 360px)` with scroll so it can never lose an
  item. `.main-row` clips overflow, and at the 900×600 minimum a stacked pane's menu
  was losing its last two actions. Positioning stays inside the existing
  `position: absolute` model — no portal, which is what was reverted last time.
- The attention panel gained the contract the pane menu already had: focus in on
  open, Escape to close, outside-pointerdown to close, focus back to the trigger,
  `aria-haspopup`/`aria-controls`/`aria-labelledby`.
- The task rail is clamped to `min(480, viewport - 560)` in the drag path, the
  arrow-key path, the rendered width and `aria-valuemax`, tracking a `resize`
  listener. A width stored in a wide window used to squeeze panes to ~138px.
- Native `<select>` option colors needed no change: `select option` in
  `Premium.css` plus `color-scheme: dark` covers all of them. Verified by
  enumerating every `<select>` against the matching rule.
- Removed dead CSS that would mislead the next edit: the `.pane-window-*` /
  `.pane-menu-item` / `.pane-select` rule set (a whole superseded pane-menu
  implementation matching no markup), the `@media (max-width: 1120px)` block
  targeting classes nothing renders, and the `@media (max-width: 720px)` block,
  unreachable below the 900px minimum.
- `.set-row` wraps and `.session-status` can ellipsize, so neither pushes a control
  off the edge at the minimum window size.

**Persistence review (was resume item 5).**

- A credential vault that cannot be decrypted no longer fails the whole load. DPAPI
  cannot decrypt a blob sealed under a different Windows profile, and that used to
  present a re-enterable key problem as the loss of every project, task and run:
  `read_store` isolates the vault step, clears the secrets, and reports
  `credentials` separately from `warning`. `src/storage.ts` surfaces it as its own
  message.
- `atomic_write` removes its temp file on both failure paths; a failing disk used to
  leave `.pending` files behind forever. The old test asserted
  `record.pending`, which never existed — it now scans the directory.

## Verification

All green, run after the final edits:

- `npm test` — **22 passed**. New: draft sanitization (`draftFromTask` keeping only
  composer fields, and a merge proving live state survives), dependency queueing,
  and a new `tests/storage.test.mjs` covering save-failure reporting, snapshot
  retention across a retry, the chain not being poisoned, and the credentials-vs-
  recovered warning split. Note the transpile rewrite order in that file: relative
  imports first, or `./native.mjs` becomes `./native.mjs.mjs`.
- `cd src-tauri && cargo test --offline` — **10 passed**, including the Windows PTY
  regression and the DPAPI tests. New: the vault store roundtrip (secrets absent
  from the plaintext store, re-inlined against the right agent, and a corrupt or
  missing blob still loading the workspace), `validate_store`'s rejection matrix,
  and the Git access-failure classifier.
- `npm run build` — passes. Vite still reports its ~673 kB chunk warning; that is a
  bundle-size note, not a measured runtime problem.
- `cargo fmt` and Prettier 3.6.2 run over every changed file. Prettier came from
  `npm exec --yes --package=prettier@3.6.2 -- prettier ...`; the sandbox's offline
  npm cache cannot see that download.

Previously verified in the isolated native app and not repeated: task launch → exit
code 0 → Review, saved output and real Git diff, installation/version check, Start
idle preserving an active session, three live terminals surviving a project switch
and a visit to Settings, command palette search/Enter/Escape, Settings and recovery
layout at 1280×820.

## Driven verification (September 11)

Run against the vite dev server in a real browser engine at a **900×600 viewport**
(the configured window minimum), seeded with `.verification/store/workspace.json`,
plus the isolated native app. Findings:

- **The first pane-menu flip fix was wrong and is now corrected.** It measured room
  against the viewport, but `.main-row` is what clips (top 107, not 0). At the
  minimum size it flipped up into a top edge it could not cross and hid _Rename
  session_, _Find in output_ and _Split right_. `AgentPane` now measures both
  directions against the clipping rect, takes the side with more room, and caps
  `max-height` to that space. Re-measured: menu fully inside the clip rect, capped
  to 234px, scrollable, **0 items clipped**, `End` scrolls _Close session_ into
  view, Escape returns focus to the right trigger with `aria-expanded=false`.
- **Rail clamp:** a stored `boardWidth` of 480 renders as 340px at 900px wide, with
  `aria-valuenow`/`aria-valuemax` both 340. Panes get 198px instead of ~138px.
- **Attention panel:** focus moves inside on open, Escape closes and returns focus
  to the trigger, outside pointerdown closes, `aria-labelledby` resolves to "Needs
  attention", panel stays inside the viewport at 900px.
- **Blocked tasks:** the card shows **Queue**, clicking it queues rather than runs
  (stays in backlog, queue reorder/cancel controls appear) and toasts "Waiting for
  … Queued to start when they finish."
- **Draft handling:** typed text survives Cancel and returns on reopen; opening an
  existing task for edit shows the task's values, not the parked draft; and saving
  that edit **leaves the parked draft intact** while the task keeps its dependency
  (still Queue + blocker line). That is the exact regression this pass fixed.
- **Broadcast:** offline panes render disabled "· offline" chips, sending with none
  running reports the honest guard instead of claiming delivery, and editing the
  message clears the stale result.
- **Focus mode:** 3 panes → 1, strip names the pane, restore returns all 3.
- **Layout at 900×600:** zero horizontal overflow anywhere; `.activity-stats` is
  4 × 202px; `.set-row` wraps so the four Backup buttons drop to a second line
  instead of escaping; every `<select option>` resolves to #161b22/#e6edf3 under
  `color-scheme: dark`; pane header is exactly 68px.
- **Git diagnostic against the real failure:** `.verification/project` is still
  sandbox-owned, and `git` there exits 128 with `detected dubious ownership` — the
  same exit code as "no repository here", confirming the message is the only
  discriminator. Its 457-char stderr classifies as a real failure (not missing-repo)
  and truncates to 301 chars.
- **Native app** (`Crucible Verification`, PID separate from the installed
  `C:\Program Files\Crucible\crucible.exe`, which was never targeted): builds with
  0 errors, boots, renders, shows `master · uncommitted changes` from the extended
  `project_info`, shows **Queue** on the blocked task, and reports "Saved on this
  device". On disk afterwards: backup rotated with each file keeping its matching
  vault blob, the stale third blob pruned, **no `.pending` leak**, and `apiKey`/agent
  `env` empty in both plaintext files.

## Installer versioning (September 11)

Investigated against the machine's actual install, not from assumption. The
installed product is MSI `Crucible 0.1.0`, ProductCode
`{C683FBAF-E149-4447-BBD2-51B6D07B88A8}`, UpgradeCode
`{610622CE-D978-5CEB-9B2F-CAC4368CAAA2}`.

- That UpgradeCode is `uuid5(DNS, "Crucible.exe.app.x64")` — derived from
  **productName**, confirmed both by computing all the candidates and by
  `npx tauri inspect wix-upgrade-code`. So the rebrand's _identifier_ change
  (`com.admin.agent-dev` → `com.admin.crucible`) did **not** break MSI upgrade
  identity, which was the first thing worth ruling out.
- The real blocker was the version: still `0.1.0`, exactly what is installed, so a
  new MSI had no higher `major.minor.build` to upgrade to. Bumped to **0.2.0** in
  `tauri.conf.json`, `Cargo.toml`, `package.json` and both lockfiles.
- `bundle.windows.wix.upgradeCode` is now **pinned** to the installed value, so a
  future productName change cannot silently orphan the install. Tauri's own config
  docs recommend exactly this. `tauri inspect` now reports the override alongside
  the derived value, and they agree.
- `identifier` must stay `com.admin.crucible`: the installed 0.1.0 build predates
  native storage and still keeps its workspace as `agentdev.workspace.v6` in
  `%LOCALAPPDATA%\com.admin.crucible\EBWebView` localStorage (verified present,
  alongside a v5). `LEGACY_KEYS` covers v6, so the first 0.2.0 launch migrates it to
  native storage and clears the legacy keys — but only while the identifier, and
  therefore the WebView2 profile, stays the same.

The rules are documented in `CLAUDE.md` ("Releasing (Windows MSI)"), mirrored into
`AGENTS.md`, and summarised in the README. No installer was built and nothing was
installed.

## Still owed

1. **Native in-window interaction was not achievable this session.** Synthetic
   mouse input does not reach WebView2's DOM, and UI Automation reports 0 buttons
   under the window root (WebView2 exposes no a11y tree without
   `--force-renderer-accessibility` or an active screen reader) — the same class of
   failure the previous checkpoint recorded for UIA. So a live PTY launch,
   broadcast delivery to a running agent, and close/save/reopen were **not** driven
   natively here. The previous session did verify task launch → exit 0 → Review with
   saved output and a real Git diff, and this pass changed neither the launch nor the
   delivery path — only the result messaging, which was verified in-browser. To drive
   the window, a session needs a desktop-control tool (the earlier `@oai/sky` via
   `mcp__node_repl__js`) or the app started with renderer accessibility forced.
2. **`src/TaskBoard.css` and `src/UsagePage.css` are imported by nothing** and style
   nothing — `main.tsx` and `App.tsx` load only `App.css` + `Premium.css`. Left in
   place deliberately rather than deleted; deleting them is a judgement call for the
   owner. Do not edit them expecting a visible change.
3. **Optional, from the persistence review:** a missing `workspace.json` returns a
   fresh workspace even when `workspace.backup.json` exists, so "primary deleted,
   backup present" is a silent fresh start. Changing that risks resurrecting a
   workspace the user deliberately reset, so it was left as-is and is now pinned by
   `validate_store_rejects_unusable_shapes`' neighbours rather than changed. A
   store-level rotation/fallback test (`load_workspace_inner`/`save_workspace_inner`
   need a `dir`-taking split to be testable) would close the last gap.
4. Signed updates and measured provider costs remain outside this development-only
   scope. Never invent quota or cost data.
5. Do **not** build or install a replacement release.

## Isolated native verification

Ignored local fixtures live in `.verification/`. Their launcher config uses
identifier `com.admin.crucible.verification` and title **Crucible Verification**,
separate from the installed application. The debug-only `CRUCIBLE_TEST_DATA_DIR`
override points native storage into the fixture directory.

```powershell
$env:CRUCIBLE_TEST_DATA_DIR='C:\Projects\agent-dev\.verification\store'
npm run tauri dev -- --config .verification/tauri.conf.json
```

The fixture has a Node test agent, two projects, tasks and recorded runs. Use
`.verification/native-project` for Git checks: it was created under the actual
desktop user. The original `.verification/project` is sandbox-owned and Git
correctly refuses it in the desktop user context — that refusal is now reported
properly instead of looking like a non-Git folder. Do not add a global
safe.directory exception. Do not reseed over useful verification state without a
reason.

DPAPI tests need the Windows user profile, so run the full Rust tests outside the
restricted sandbox with the normal approval mechanism.

Use the existing computer-use skill and `@oai/sky` through `mcp__node_repl__js` for
native UI. Refresh after each action. Coordinate actions worked; UIA click/set-value
had stale-input/cache failures. Never target the separate installed **Crucible**
window. A physical Escape safeguard requires stopping desktop control for that turn.
