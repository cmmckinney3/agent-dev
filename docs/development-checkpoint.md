# Development checkpoint — October 4, 2026

**Development only: do not replace, install over, or modify the installed Crucible
app.** Resume this working tree; do not reset it. Many files were already modified
before this implementation.

The resume list from the previous checkpoint (September 10) is complete except for
the native desktop verification noted under "Still owed" below. Everything else in
that list was either implemented or verified as already correct.

## Claude Code hooks: exact status (October 4)

Plan: `docs/agent-status-plan.md` section 10 (phase 1b).

- **Hook mode** (`desktop.rs`, `main.rs`): `crucible --crucible-hook <event>`
  reads the event from stdin (1 MiB kept, the rest drained) and prints
  `claude_hook_output`: JSON whose `terminalSequence` is `ESC]777;crucible;
  <event>;<kind>;<text>BEL`. Text is single-line, control-free and capped at
  200 characters; a permission's file path is made relative to the session's
  folder (ASCII case and slash direction ignored, so a sibling such as
  `C:\Work\Apple` is not inside `C:\Work\App`). Unknown events print `{}`.
- **Settings file**: `claude_hook_settings` writes
  `<data dir>/claude-hooks.json` (exec-form hooks for UserPromptSubmit, Stop,
  StopFailure, PermissionRequest and Notification, running the current
  executable, 10 s timeout) and returns its path.
- **Launches** (`App.tsx`): `withHooks` prepends `--settings <path>` for
  interactive Claude Code launches (manual start, resume, interactive task)
  when `settings.claudeHooks` is on (default) and the agent does not pass its
  own `--settings`. `startManual` now holds the pane's reservation while it
  waits, so a double click cannot start it twice.
- **Model** (`activity.ts`): `parseHook`, `onHook`, `hooked`, `held` as in the
  plan; `sessions.ts` registers an OSC 777 handler that passes anything not
  `crucible;` back to the terminal. The pane's status tooltip says "Reported by
  Claude Code" for a hooked session.
- **Setting**: Settings → Workspace → "Exact status from Claude Code".

**Verification**

- `npm test` — **105 passed** (new: hook parsing and transitions in
  `tests/activity.test.mjs`, the OSC 777 path in
  `tests/session-lifecycle.test.mjs`, whose terminal stub now keeps OSC
  handlers by number, and `tests/agents.test.mjs` for `isClaudeCode`,
  `withHookSettings` and the setting). `npm run build` passes.
- `cargo test --offline` — **21 passed** (3 new: the output is one allowlisted
  OSC 777 with clean text and nothing of the prompt, permission details and
  relative paths, the settings file's exec-form hooks).
- **Real Claude Code 2.1.289** in a ConPTY (a scratch harness, environment
  cleared of the calling session's variables, the debug build as the hook):
  a plain prompt produced `UserPromptSubmit` at 4.2 s and `Stop` at 7.2 s; in
  `--permission-mode default` a Write produced
  `PermissionRequest;Write;…\hook-probe.txt` before the dialog, and Esc
  rejected it with no `Stop`. Hook mode takes about 25 ms warm. A
  GUI-subsystem executable (as a release build is) reads and writes piped
  stdio normally.
- In the vite dev server with the IPC mock, through the real xterm.js parser: a
  manual Claude Code start passed `--settings`; prompt → Working, permission →
  "Needs you · Allow Write: hook-probe.txt?" held while the dialog drew, a
  foreign OSC 777 ignored, Stop → Done on the pane and the Dashboard, nothing
  printed on screen. Headless runs and launches with the setting off got no
  `--settings`.

- **Version 0.8.0** in `tauri.conf.json`, `Cargo.toml`, `package.json` and both
  lockfiles, so the next MSI upgrades an installed 0.7.0 in place. `upgradeCode`
  and `identifier` are unchanged.

**Still owed (native)**

- A Crucible build running real Claude Code sessions end to end (installed
  path with spaces, `Program Files`), including a permission prompt in a
  session that is not in auto mode. The owner's Claude Code runs in auto mode,
  so most turns will show Working → Done with no permission prompt.

## Teammate messaging (October 3)

Plan: `docs/messaging-plan.md`. The owner asked for agents that talk to each
other, since many of their projects share a stack.

- **Channel.** A teammate run now gets its own folder,
  `<run folder>/.crucible/<name>-<run id tail>/`, with `memory.md`, `inbox.md`
  (only when messages are delivered) and an empty `outbox.md` (only when it may
  message and has teammates). `seed_teammate_run` / `collect_teammate_run`
  replace `seed_memory` / `collect_memory`; the folder (and an empty
  `.crucible`) is removed after the run, keeping any other file the teammate
  left there. Seeding and removal share a lock, every path is checked to
  resolve inside the run's folder before it is written, read or removed, and
  `.crucible/` stays in `info/exclude`.
- **Model** (`src/messages.ts`, pure): `TeamMessage { from (teammate or
  "owner"), fromName snapshot, to, body (4000), at, projectId, cwd, runId, hop,
  deliveredAt, deliveredRunId, taskId }`. `Workspace.messages` normalizes to
  `[]` (no `STORAGE_KEY` bump); messages to a missing teammate are dropped; 500
  are kept, delivered ones dropped first. `Teammate.canMessage` (default on)
  and `onMessage` (`hold` default, or `start`); `Task.messageIds` / `Task.hop`
  on message tasks (cleared by Duplicate); `RunRecord.request`;
  `Settings.messageStarts` (on) and `messageChainLimit` (3, 1–10).
- **Sending.** The prompt lists the other teammates by name and the outbox
  path (no quotes or angle brackets, which cmd.exe refuses). App reads the
  outbox when the pane's activity leaves Working while the run is live, and at
  the run's end; `readOutbox` takes `## To:` headings (bold or a bare line that
  names a teammate also works; "Ben (re: auth)" matches Ben), `everyone`, and
  reports unknown names once per run. Keys of sent messages are kept per run,
  so the teammate can keep or clear the file; 10 a run at most.
- **Delivery.** `startTask` gives a teammate run its waiting messages (oldest
  first, 20 at most, plus a message task's own) as `inbox.md`; the prompt says
  how many. They are marked delivered only if the process starts. The inbox
  quotes the recipient's own last message to each sender, for a reply's
  context.
- **Message tasks.** A recipient set to `start` (and Settings on, and the hop
  within the limit) gets a headless task titled "Message from Ada" in the
  sender's folder, `isolation` off, prompt fixed text. A new message joins an
  unstarted one (same teammate, project and folder) instead; one created while
  the teammate already has a run in that folder is queued until it ends
  (`messageTaskWaits`, also checked by the queue drain). **Start a task** on a
  waiting message does the same by hand, whatever the setting.
- **UI.** Teammates page tabs: Profile, Memory, Messages (both settings, a box
  to write to the teammate, the thread in and out with Waiting / Delivered,
  Open task / Start a task, Delete, long bodies folded), Work. Waiting counts
  on each teammate and on the header's Teammates button. One toast says what
  happened to every message of a send (and carries the memory note when a run
  did both). Task detail lists a message task's messages. Settings → Task
  board: "Messages can start tasks", "Longest message chain". Deleting a
  teammate drops the messages sent to it and archives its unstarted message
  tasks.

**Bugs fixed on the way**

- Two runs of one teammate in one folder shared a memory file, so the second
  seed overwrote the first run's notes (now a folder per run).
- Memory files stayed in project folders after runs (now removed).
- A half-written new-task draft and prompt templates lost their teammate on
  reload (`normalizeWorkspace` dropped `teammateId`).
- An agent review of a teammate's task quoted the whole teammate preface
  ("You are Ada…", memory path) as the original request; runs now record the
  request on its own (`RunRecord.request`).
- The board's agent filter ignored a teammate's engine.
- Closing Crucible while a teammate ran lost its memory: the close now waits
  for stopped runs' folders to be read before saving.
- Opening the Teammates page from a toast for a teammate already focused once
  did nothing (the focus is now a fresh object each time).
- A teammate name holding `& | < > " % ! ^` would make every teammate prompt
  unusable by a batch-script agent; such names are now refused (and cleaned on
  load).

**Verification**

- `npm test` — **96 passed**: 16 new in `tests/messages.test.mjs` (outbox
  parsing, inbox text, delivery, arrival and chain, message tasks, waiting,
  normalization, retention) plus new teammate, workspace and review cases.
  `tests/modules.mjs` now gives every test file the full module list.
- `npm run build` — passes. `cargo test --offline` — **18 passed** on
  Windows; the four memory tests became five run-folder tests (names, round
  trip with mid-run read and removal, files the teammate added are kept,
  worktree exclusion, non-Git folder).
- Driven in the vite dev server with the Tauri IPC mock: Ada's headless run
  wrote to Ben (start), Cleo Park (hold) and an unknown name; one toast
  reported all three plus her memory update; Ben's message task started with
  the message in its inbox and only the path in its prompt. Ben's reply waited
  in Ada's inbox; **Start a task** on it gave Ada an inbox quoting her earlier
  message. With the chain limit at 2 Ada's next reply waited ("reached its
  limit of 2"); with message tasks paused an owner message waited too. Cleo's
  interactive run received two messages, and her outbox was delivered at the
  end of a turn while the run was still live, once (not again at its end).
  Messages for Ben while he worked queued one task, which a third message
  joined and which started with both when he finished. 900×600: no horizontal
  overflow on the page or header.

- **Version 0.7.0** in `tauri.conf.json`, `Cargo.toml`, `package.json` and both
  lockfiles, so the next MSI upgrades an installed 0.6.0 in place. `upgradeCode`
  and `identifier` are unchanged.

**Still owed (native)**

- A real Claude Code and Codex run as a teammate that writes a message: the
  agent edits `.crucible/<name>-<run>/outbox.md` without a permission prompt
  (a headless Codex run needs `-s workspace-write` or similar, or it cannot
  write memory or messages), and the folder is gone from the project after the
  run.
- A real message-started task end to end, and closing Crucible during a
  teammate run (its memory and messages should still arrive).

## Teammates with per-teammate memory (October 1)

Plan: `docs/teammates-plan.md`. The owner chose memory per teammate (not a
shared per-stack layer) as the first step toward BridgeMind-style Agent mode.

- **Model** (`src/teammates.ts`, pure): name (unique, case-insensitive, 40
  chars), engine (`agentId`), brief (2000), memory (16000), timestamps.
  `Workspace.teammates` is normalized to `[]` when absent (no `STORAGE_KEY`
  bump, like `dashboardOpen`); strict import rejects a non-list. Engines that
  leave the catalog fall back to its first entry, and `remapAgent` moves
  teammates with tasks. `Task.teammateId` is composer-owned, so `draftFromTask`
  now carries it (its whitelist test was updated) and it is dropped on load when
  the teammate is gone. `RunRecord` keeps `teammateId` and a `teammateName`
  snapshot.
- **A teammate's run.** `startTask` uses the teammate's engine, writes its
  memory with `seed_memory` into `<run folder>/.crucible/memory/<slug>-<id
tail>.md`, and sends `teammatePrompt`: "You are <name>…", the brief, the
  file's relative path and how to keep it, then the usual `launchPrompt`. The
  run record stores that prompt. The memory text itself is never in argv.
- **After the run** (exit, stop or failed start) `collect_memory` reads the file
  and `mergeMemory` folds it in: if the stored memory is unchanged since the
  seed the file replaces it (the teammate may prune); if it changed (edited on
  the page, or another run merged first) only the run's new lines are appended.
  A toast offers **View memory**. A run still going when Crucible closes is not
  collected.
- **Native** (`desktop.rs`): `seed_memory` accepts only `[a-z0-9-]+.md` names,
  refuses a `.crucible` that resolves outside the folder, writes atomically, and
  adds `.crucible/` once to the file `git rev-parse --git-path info/exclude`
  names (the shared one from a worktree). `git ls-files --exclude-standard`, which
  run snapshots use, therefore never lists it. `collect_memory` reads at most
  256 KiB.
- **Version 0.6.0** in `tauri.conf.json`, `Cargo.toml`, `package.json` and both
  lockfiles, so the next MSI upgrades an installed 0.5.0 in place. `upgradeCode`
  and `identifier` are unchanged.
- **UI.** Teammates page (header, between Workspace and Activity): list with
  engine and note count; editor for name (validated in place), engine, brief,
  memory (monospace, no spellcheck, counts, last update, two-step Clear), recent
  runs and Delete (asks first; tasks keep their engine). The composer's picker is
  "Who does it" with Teammates and Agents groups. Cards, task detail ("Teammate:
  <name>", opens the page), the Dashboard and the palette name the teammate.

**Verification**

- `npm test` — **80 passed** (10 new in `tests/teammates.test.mjs`). Note for
  the next change: each test file transpiles its own list of modules into a temp
  folder, so when a pure module gains an import (`workspace.ts` now imports
  `teammates.ts`), add it to every test file that loads an importer or the
  whole file fails to load.
- `npm run build` — passes. `cargo test --offline` — **17 passed** on Windows,
  4 new: name validation, round trip with the exclude line written once and
  `git status` clean, a worktree covered by the shared exclude, and a non-Git
  folder.
- Driven in the vite dev server with the Tauri IPC mock: created Ada on the
  page, ran a task as Ada and checked the `seed_memory` call (memory to
  `ada-8304bf.md` in the project folder) and the prompt (preface, brief, path,
  task, and no memory text); returned a file with a new line and saw "Ada's
  memory was updated." and the merged notes (CRLF normalized). A second task in
  another project was seeded with those notes; adding a note on the page during
  that run and returning a file that pruned one line and added another kept the
  owner's note, appended the new one and ignored the prune. Duplicate names are
  refused in place; 900×600 has no horizontal overflow.

**Still owed (native)**

- Run a real Claude Code and Codex task as a teammate: confirm each reads and
  updates `.crucible/memory/…` without permission prompts, and that the file
  stays out of `git status` in the real repository.

## Review verdicts (October 1)

Phase 2 of `docs/agent-status-plan.md` (section 9). Frontend only.

- **Reading the verdict.** When an agent-review task's run exits, App reads the
  run's saved output with `read_run` (the backend syncs the log before it emits
  `agent-exit`) and runs `parseVerdict` (`src/review.ts`, pure). The verdict is
  the last line starting with `APPROVE`/`APPROVED`/`REQUEST CHANGES`/`CHANGES
REQUESTED` after Markdown decoration and an optional `Verdict:` label; without
  the label the keyword must be upper case. Lines that also appear in the prompt
  are skipped. Real `codex exec` 0.159.3 output was captured: in a terminal it
  logs a header, `user` plus the **echoed prompt**, `codex` plus the answer,
  `tokens used` and a count, then prints the answer again. Findings are the
  lines after the verdict up to such a marker, or the block before it when
  nothing follows; control characters stripped, capped at 4000.
- **Recording it.** Found: the review stores `Task.verdict` (`approve` or
  `changes`, findings, run id, time), loses its generic attention line and moves
  to Done unless headless runs "stay"; the reviewed task gets "Agent review
  approved" / "Agent review requested changes"; a toast opens it. Not found, or
  recording off, or the read failed: the review's attention says why and a toast
  opens the review. A re-run clears the verdict; Duplicate does not copy it.
- **Using it.** The reviewed task's detail shows a verdict chip per review and
  the latest verdict's findings. On REQUEST CHANGES, **Use as change request**
  opens the existing Request changes form prefilled with them (after any pending
  request, without repeating it) and focuses it. Nothing is sent until the user
  chooses Send back. A review's own detail shows its verdict. Cards read
  **Review · Approved** / **Review · Changes**.
- **Version 0.5.0** in `tauri.conf.json`, `Cargo.toml`, `package.json` and both
  lockfiles, so the next MSI upgrades an installed 0.4.0 in place. `upgradeCode`
  and `identifier` are unchanged.
- `plainOutput` moved from `RunReview.tsx` to `review.ts` so the parser can be
  tested. `Task.verdict` is optional and normalized (dropped when malformed,
  findings capped); no `STORAGE_KEY` bump.

**Verification**

- `npm test` — **70 passed** (9 new in `tests/review.test.mjs`, including the
  captured Codex output with its prompt echo and token footer).
- `npm run build` — passes (strict `tsc`).
- Driven in the vite dev server with the Tauri IPC mock: Ask for review spawned
  Codex with the real reviewer prompt; its Codex-style log (echoed prompt,
  verdict, footer, repeated answer) produced "Review of “Fix the flaky auth
  test”: changes requested", the builder's "Agent review requested changes",
  the review card in Done as **Review · Changes**, and findings of exactly the
  two numbered items. **Use as change request** prefilled and focused the form;
  **Send back and re-run** launched the builder with the original request,
  `Changes requested after review:` and both findings. A reviewer with no verdict
  left its card in Review with the reason; an `**Verdict: APPROVE**` reviewer
  gave "approved", the builder's "Agent review approved", and no Use button.
- Prettier 3.6.2 on every changed file that was clean before; `RunReview.tsx`
  and `workspace.ts` were not, and only their new lines follow it.

**Still owed (native)**

- Ask for review with real Claude Code and Codex reviewers, and check the
  verdict and findings against what each actually printed.

## Agent status, Dashboard and notifications (October 1)

Direction: `docs/bridgemind-research.md` (the owner chose BridgeMind-style agent
status and a Dashboard, then verdicts, teammates with memory and messaging).
Plan, and what changed while building: `docs/agent-status-plan.md`. This is
phase 1.

- **Activity model** (`src/activity.ts`, pure). A running session is _Working_,
  _Needs you_, _Done_ or _Idle_, inferred from the PTY stream so it works for any
  CLI. Output within 400 ms of the user's input or a resize is an echo/redraw;
  other output starts Working when a turn is pending (a seeded task prompt, or a
  line submitted with Enter) or after 300 ms of closely spaced chunks. Working
  ends after 2 s of quiet (10 s before the first output). The last ten screen
  lines, with box borders stripped and soft wraps joined, are then checked for an
  approval prompt: a match is Needs you with the question as the reason;
  otherwise Done if a turn was pending, else Idle. OSC 9 and BEL (not one right
  after a keystroke) go straight to Needs you. Focus and mouse reports are not
  the user answering. Process exit is Done (with the exit code) until seen; a
  stop the user asked for is Idle.
- **Sessions.** `sessions.ts` feeds the model and publishes only real
  transitions (`subscribeActivity`), never per output chunk. App drives
  `tickActivity()` once a second; the module still holds no timers. `markSeen`
  runs on pane focus/click and Dashboard open. `Launch.seeded` is set by
  `startTask` only.
- **Pane header.** The status chip says Working / Needs you / Done / Idle while
  the process runs (the reason is its tooltip) and the process state otherwise.
- **Dashboard** (`src/Dashboard.tsx`): header button with a Needs-you count
  badge, `Ctrl Shift D` (reserved in the terminal key handler too) and a palette
  action. Four count tiles, then sections across **all** projects, a row per
  session with agent accent, task title or session name, agent · project, the
  reason, and status with time in state. A row switches project, focuses and
  marks the pane seen, and flashes a ring around it (steady under reduced
  motion). Docked at 300px from 1100px wide; below that it floats over the panes
  and closes when a row is opened. `dashboardOpen` persists (no `STORAGE_KEY`
  bump; additive boolean like `boardCollapsed`).
- **Version 0.4.0** in `tauri.conf.json`, `Cargo.toml`, `package.json` and both
  lockfiles, so the next MSI upgrades an installed 0.3.0 in place. `upgradeCode`
  and `identifier` are unchanged. The notification plugin moved Tauri itself from
  2.11 to 2.12 (Rust crate and `@tauri-apps/api` together).
- **Notifications.** `tauri-plugin-notification` (Rust crate, JS package,
  `notification:default` capability). Settings → Workspace → **Desktop
  notifications**: when Crucible is in the background (default), always, or off.
  Sent on transitions to Needs you or Done; the body is agent · project and the
  reason only. Permission is requested on first use; failures are swallowed
  (`src/desktopNotify.ts`). Taskbar attention on run completion is unchanged.

**Verification**

- `npm test` — **61 passed** (15 new in `tests/activity.test.mjs`, one session
  lifecycle test of activity through the real registry, one normalization test).
  The approval-prompt patterns are pinned against wording found in the installed
  Claude Code 2.1.284 and Codex 0.159.3 binaries.
- `npm run build` — passes (strict `tsc`); only the existing chunk-size note.
- `cd src-tauri && cargo test --offline` — **13 passed on Windows**, including
  the Windows-gated PTY and DPAPI tests that the September 29 pass could not run.
- Driven in the vite dev server with Tauri's own IPC mock (`mockIPC` with mocked
  events and `mockWindows`) standing in for the native side, so real xterm
  terminals received scripted agent output: a Claude-style permission box became
  Needs you with "Do you want to proceed?"; streaming Codex output stayed
  Working; a seeded task and a submitted follow-up ended Done; an exit read
  "Process exited" and a user stop "Stopped" (Idle). The Dashboard grouped all of
  them across two projects; a row switched project, focused the terminal and
  flashed the pane; Tab reaches rows with the focus ring; `Ctrl Shift D`
  toggles; at 900×600 there is no horizontal overflow and the floating Dashboard
  leaves the panes 604px. With notifications on Always, an OSC 9 request produced
  "Needs you: Session 2" / "Codex · crucible / Codex needs approval to run git
  push"; on "in the background" with the window focused, nothing was sent.
- Prettier 3.6.2 on every changed file that was clean before. `sessions.ts`,
  `icons.tsx`, `workspace.ts` and `SettingsPage.tsx` were not clean before and
  were left unformatted apart from the new lines.

**Still owed (native)**

- Run Claude Code and Codex in the real app: a task should go Working → Done, a
  permission prompt Needs you with its question, and a desktop notification
  should arrive with Crucible in the background (first use asks permission).
- Watch for false states with real TUIs: any periodic redraw while idle that
  reads as Working, or an approval prompt worded unlike `WAITING_PATTERNS`.
- Phase 1b (Claude Code hooks) and phases 2–3 are in the plan, not built.

## Review loop (September 29)

Plan and rationale: `docs/review-loop-plan.md`. Frontend only — no Rust changes.

- **Change requests now reach the next run.** "Request changes" used to move the
  card to Backlog with `attention: "Changes requested"` and nothing else, so the next
  launch re-sent the original prompt and the reviewer's feedback never reached the
  agent. The text is now stored on the task as `changeRequest`, and every launch
  sends `launchPrompt(task)` (`src/tasks.ts`): the request, a blank line, the
  heading `Changes requested after review:`, then the feedback. A blank request
  returns `task.prompt` unchanged. It stays until the task is marked reviewed &
  done, **Cleared** in task detail, or replaced by a new request. `startTask` and
  `createRun` both go through `launchPrompt`, so a run record's `prompt` stores
  exactly what was sent. A card with a pending request shows a `Changes` chip.
  `draftFromTask` stays a whitelist and carries neither new field.
- **Agent review tasks.** Task detail gains an **Agent review** block: pick an
  enabled reviewer (default is a different agent from the builder when one exists,
  via `pickReviewer`) and **Ask for review**, which is disabled while the task runs
  or before it has any run. That creates a `Review: <title>` task in the same
  project through `reviewTaskFor`: `mode: "headless"`, `isolation: false` so it
  sees the builder's files rather than a fresh worktree, `cwd` from the builder's
  last run folder (then its worktree, then its own cwd), and `reviewOf` pointing at
  the builder task. It starts immediately and queues like any task when no pane is
  free. The prompt (`buildReviewPrompt`, `src/review.ts`) carries the request that
  was sent, where to look (`git diff HEAD` for a worktree, `git diff` with a caveat
  for a shared folder), the changed-file list captured for the run (capped), the
  builder's exit code and the review instructions. The builder's detail lists its
  reviews (`reviewsOf`) with an **Open** link; a review task links back and shows a
  `Review` chip. Reviewers report findings only; they are told not to edit files.
- **Settings → Task board → Review instructions.** `reviewInstructions` is a
  textarea appended to every reviewer prompt (capped at `REVIEW_INSTRUCTIONS_MAX`
  = 4000). A blank value falls back to `DEFAULT_REVIEW_INSTRUCTIONS`, and **Reset
  to default** restores it. The default asks for correctness, regression, test and
  edge-case checks and ends with an `APPROVE` or `REQUEST CHANGES` verdict line.
- **Argv safety constraint.** Prompts travel as argv (32 KiB on Windows), and a
  non-npm batch agent still goes through `cmd.exe /c` (see below). The reviewer
  prompt therefore never embeds diff text or agent output — only fixed text, the
  user's own request and change request, file paths (control characters stripped,
  each truncated), status words and an exit code. Only `path` and `status` are read
  from the file list, so an extra `diff` property cannot leak in.
- **No `STORAGE_KEY` bump** (still `agentdev.workspace.v7`). `changeRequest` and
  `reviewOf` are optional, additive task fields that `normalizeWorkspace` tolerates
  whether present or absent, so no stored workspace needs migrating and the
  top-level `Workspace` shape is unchanged. `changeRequest` is kept only when it
  has non-blank text; `reviewOf` is dropped when dangling or self-referential, even
  in strict mode, since a dangling link is not a corrupt backup.
- `duplicateTask` resets both fields, and **Mark reviewed & done** clears
  `changeRequest`.

- A change request is also cleared whenever the task reaches Done another way
  (dragged there, or a headless exit 0 under "Done if exit 0"), so a later re-run
  cannot resend stale feedback. **Ask for review** stays available for a task in
  Review or Done with no run records (history recording off, or pruned); the
  prompt then says no file list was captured. A ref guard stops a double click
  from creating two reviews while `read_run` is in flight.

**Also fixed in this pass**

- **Prompts through `cmd.exe` (security).** `resolve_command` routed every Windows
  npm `.cmd` shim (`codex.cmd`, npm-installed `claude.cmd`) through `cmd.exe /c`.
  portable-pty quotes arguments MSVC-style (`"` becomes `\"`, confirmed in
  `cmdbuilder.rs`), which cmd.exe does not honour: a prompt such as
  `say "hi" & echo X` ran a second command, `%VAR%` expanded, and a line break
  ended the command, silently truncating multi-line prompts. `npm_shim_command`
  now reads the shim (modern and legacy cmd-shim layouts), and launches its
  script with `node` directly, using the `node.exe` beside the shim first, then
  `node` on `PATH`. An `.exe` target is launched as itself. Any other
  `.cmd`/`.bat` still uses `cmd.exe /c`, but `spawn_agent` now refuses a prompt
  holding `" % ! ^ & | < >` or a line break with an explicit error instead of
  launching it. `check_agent` shares `resolve_command`, so the version check
  follows the same path. New tests: `shim_tests::*` (not Windows-gated).
- **Modal keyboard handling.** `Modal` listened for keys on its own panel. An
  action that removes the focused control, such as the new Clear or Send back
  buttons, dropped focus to `<body>`. Escape then stopped closing the dialog, and
  Tab walked into the page behind an `aria-modal` dialog. The listener now sits on
  the document and answers only for the topmost dialog, since the palette can open
  over task detail. Tab from outside the panel re-enters it.
- **Version 0.3.0** in `tauri.conf.json`, `Cargo.toml`, `package.json` and both
  lockfiles, so the next MSI upgrades the installed 0.2.0 in place. `upgradeCode`
  and `identifier` are unchanged.

**Verification**

- `npm test` — **44 passed** (22 new in `tests/review.test.mjs`).
- `npm run build` — passes (strict `tsc`); only the existing ~675 kB chunk note.
- `cd src-tauri && cargo test` — **10 passed** on Linux, including the 3 new shim
  tests. The Windows-gated PTY and DPAPI tests could not run here.
  `cargo fmt --check` is clean.
- Driven in Chromium against the vite dev server (seeded workspace, 1280×820 and
  900×600), with no console errors. Checks:
  - the `Changes`/`Review` card chips, the pending change request, and the
    reviewer default (a different agent) with `(same agent)` labelling;
  - the Request changes form: `aria-expanded`, prefilled and focused, closing on
    send, and the card moving to Backlog;
  - the review ↔ reviewed-task links, and Clear removing the chip;
  - after Clear: Tab stays in the dialog and Escape closes it;
  - palette over detail: Escape closes one layer at a time;
  - the Settings review instructions: Reset disabled at default, search finds the
    row;
  - no horizontal overflow at 900 px.
- Prettier 3.6.2: every changed file that was clean before is still clean.
  `settings.ts` and `Modal.tsx` are now clean. `workspace.ts` and
  `SettingsPage.tsx` were not clean before and were left alone, with the new lines
  written to the formatter's style.

**Still owed**

- Nothing was driven natively: no Windows desktop was available in this session.
  To check end to end:
  - launch Codex (an npm shim) with a prompt containing `"`, `&`, `%PATH%` and a
    line break, and confirm it arrives intact;
  - run **Ask for review** from the app window;
  - run the Windows-gated Rust tests.

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
- Review loop: change requests that reach the next run via `launchPrompt`, and linked headless agent-review tasks with configurable review instructions. npm cmd-shims launch without `cmd.exe`.

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
