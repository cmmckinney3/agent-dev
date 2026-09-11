# Crucible: premium experience audit

Reviewed September 10, 2026, against the current working tree, including existing uncommitted changes.

**Recommendation:** make Crucible a project workspace that carries work from prompt to reviewed result. The most valuable improvements are calmer controls, trustworthy session behavior, clear attention states, and persistent results.

The existing foundation is useful: real terminals, a configurable agent catalog, task scheduling, flexible pane layouts, terminal search, run history, and settings that drive real behavior. Preserve the compact dark design and terminal fidelity while improving the workflow around them.

## What was checked

- Read the React screens, task and run models, scheduling and persistence logic, styling, agent configuration, and Rust PTY manager.
- Opened the workspace, task composer, Usage, Settings, and agent manager in a browser preview.
- Measured the default three-pane workspace at 1280 × 720. Its task rail is 332 px wide; each pane is about 315 px wide with a **144 px header**. Pane controls occupy almost a quarter of the 607 px workspace height before terminal content begins.
- `npm run build` passed. Vite reported a roughly 648 kB JavaScript chunk and its standard bundle-size warning.
- `cargo check --offline` passed.

The browser preview lacks Tauri's native bridge and logged `transformCallback` errors when registering terminal listeners. This audit verifies frontend rendering and source behavior, not a successful desktop PTY session. Native process launching, provider authentication, file dialogs, populated run history, and sustained multi-agent performance still need desktop verification. The `agent-browser` executable was unavailable, so browser inspection used the connected browser tool.

## Highest-value updates

Effort is relative: **S** = focused change, **M** = several coordinated components, **L** = new subsystem or substantial lifecycle work. These are scope estimates, not delivery promises.

| Order | Update | What the user gains | Effort |
|---|---|---|---|
| 1 | Repair launch, delivery, and restore behavior | Actions do exactly what their labels promise; mistakes do not silently lose work | S–M |
| 2 | Simplify the shell and pane headers | More space for work, fewer competing buttons, clearer navigation | M |
| 3 | Add a focused session view | Expand a busy pane and return to the previous layout without losing terminal state | M |
| 4 | Introduce projects and recent workspaces | Project name, folder, branch, preferred agents, and saved layout stay together | M–L |
| 5 | Build a task detail and review surface | Inspect the prompt, run attempts, saved output, changed files, and next action in one place | L |
| 6 | Add attention states and notifications | Find blocked, failed, or finished work without watching every terminal | M–L |
| 7 | Save transcripts and support recovery | Return to results after a restart; resume supported agents or deliberately start a new run | L |
| 8 | Add command palette and global search | Open projects, tasks, sessions, and actions quickly from the keyboard | M |
| 9 | Improve task planning and queue control | Search, filter, prioritize, reorder, duplicate, cancel queued work, and archive completed tasks | M |
| 10 | Guide agent setup and organize settings | Know which tools are installed and ready; keep advanced CLI configuration available but out of the default path | M |
| 11 | Make history useful for decisions | Search all retained runs, inspect failures, and view provider-reported usage when available | M–L |
| 12 | Finish desktop polish | Restore window placement, expose shortcuts, provide accessible menus, and make updates predictable | M |

## Fix these trust gaps first

These are findings from the current code paths. They were not exercised against live coding agents during this audit.

**1. “Start all” can restart agents already working.** When some panes are idle, the button remains enabled. Its handler calls `start()` for every pane. The backend replaces an existing session under the same ID and kills the previous child. Change the action to “Start idle” or start only idle/exited panes; keep restart explicit. Verify with one running pane and one idle pane: the running process and its output must survive unchanged. Evidence: [App.tsx:1126](C:/Projects/agent-dev/src/App.tsx:1126), [AgentPane.tsx:432](C:/Projects/agent-dev/src/AgentPane.tsx:432), [lib.rs:80](C:/Projects/agent-dev/src-tauri/src/lib.rs:80).

**2. Broadcast can falsely imply successful delivery.** `send()` suppresses write failures. The broadcast handler waits for those suppressed results, clears the draft, and displays its sent state. It also targets selected panes without requiring a running process. Show eligible recipients, return a delivery result for each pane, retain failed messages, and distinguish delivery to the terminal from acknowledgment by an agent. Evidence: [AgentPane.tsx:471](C:/Projects/agent-dev/src/AgentPane.tsx:471), [App.tsx:1146](C:/Projects/agent-dev/src/App.tsx:1146).

**3. A task can inherit a previous task's directory.** A task with an explicit directory writes that directory into the pane override. A later task without a directory launches using that override before the shared default, although the task model and composer describe inheriting the shared default. Keep task-specific directories scoped to their runs and show the resolved project before launch. Verify two sequential tasks with different directory policies. Evidence: [App.tsx:883](C:/Projects/agent-dev/src/App.tsx:883), [tasks.ts:14](C:/Projects/agent-dev/src/tasks.ts:14).

**4. Restore accepts data that can break the next load.** Import validates the root object and presence of `layout` or `agents`, then overwrites storage. Loading assumes `tasks` has array methods. For example, an object containing `"layout": []` and `"tasks": {}` passes the import gate but fails at `raw.filter`. Validate and normalize the complete backup before replacing anything, keep a last known good copy, and provide a recovery screen. Evidence: [App.tsx:1083](C:/Projects/agent-dev/src/App.tsx:1083), [App.tsx:133](C:/Projects/agent-dev/src/App.tsx:133).

**5. Credentials are included in ordinary workspace backups.** The OpenRouter key lives in plaintext settings and is copied with the full workspace JSON. Agent environment maps can also contain credentials. Separate secrets from workspace data; redact exports by default and make any credential export explicit. A protected credential store should be selected with its unlock and recovery behavior in mind; Tauri documents [Stronghold for secret storage](https://v2.tauri.app/plugin/stronghold/). Evidence: [settings.ts:26](C:/Projects/agent-dev/src/settings.ts:26), [App.tsx:1048](C:/Projects/agent-dev/src/App.tsx:1048), [SettingsPage.tsx:782](C:/Projects/agent-dev/src/SettingsPage.tsx:782).

**6. Save failures disappear silently.** The workspace persistence effect catches storage failures without a user-visible result. Show a persistent, actionable “Changes could not be saved” state and provide an export/retry path. Debounce layout drag persistence and keep critical task transitions durable. Evidence: [App.tsx:428](C:/Projects/agent-dev/src/App.tsx:428).

## Visual direction

**Keep the dark palette; reduce the amount of competing chrome.** There are already reusable surface, border, typography, accent, and focus tokens. Extend those rather than replacing the UI system.

| Area | Current observation | Proposed experience |
|---|---|---|
| App header | Navigation, directory field, agent management, four layouts, live count, start and stop all share one row | Stable navigation and project context; workspace actions appear in the workspace; layout choices move into one labeled menu |
| Pane header | Session title, rename button, agent selector, executable badge, directory, start, stop, Window menu, and repeated split/close buttons wrap across rows | A compact identity/status row and a small context row; one primary lifecycle action, focus/expand, and an overflow menu |
| Terminal area | Three equal columns start at about 315 px each with the task rail open | Make one focused pane easy to expand; offer tabs or a main-plus-secondary arrangement when space is limited |
| Task rail | Four empty status boxes repeat placeholders; composer occupies much of the same narrow rail | Useful first-task guidance, collapsible groups, a resizable rail, and a wider task detail/composer surface |
| Broadcast | Always-visible recipient chips and an input consume the bottom edge | An expandable composer showing running recipients, send behavior, and delivery results; preserve multiline prompts |
| Settings | Long scrolling form with detailed provider wiring near the top | Category navigation and search; concise descriptions; advanced argument/environment details behind disclosure controls |

Aim for **56–72 px pane headers** at the audited width instead of 144 px. This is a proposed design target: preserve readable labels and access to every action while recovering terminal space.

Use a consistent UI type scale: roughly 13–14 px for primary controls, 12 px for supporting information, and small text only for genuinely secondary metadata. Keep terminal size independently adjustable. Many current captions are 11–11.5 px, which makes dense screens harder to scan.

Give brand, selection, agent identity, and runtime status distinct roles. A restrained orange Crucible mark can coexist with blue focus/selection and semantic success/failure indicators. Show status text or an icon alongside color so an agent's teal or green identity is not mistaken for a successful run.

Normalize button heights, input padding, icon sizes, border emphasis, menu placement, and disabled-state treatment. Prefer one clear border around a group over several nested bordered boxes. Keep motion short and functional, respecting the existing reduced-motion setting.

Make keyboard behavior complete: focus the first menu action when opened, support expected arrow navigation, close with Escape, and return focus to the trigger. Preserve existing strengths such as terminal search, accessible split separators, and the agent dialog's focus trap. Check pointer targets against the [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum), which includes a 24 CSS px minimum and exceptions for spacing and other conditions. The measured directory controls are 21 px high; this warrants review, not an automatic conformance verdict.

## Features that would change daily use

**Projects as the organizing unit.** Replace the anonymous directory field with a named project switcher, recent projects, branch context, and an explicit effective directory. Store project-specific tasks, preferred agents, and layout presets. Switching projects must not kill work in another project.

**A real review flow.** A task should open into a detail surface with its original request, run attempts, resolved project, agent/model snapshot, saved output, changed files, and checks. Provide “Request changes,” “Re-run,” and “Mark reviewed” actions. Exit code 0 means a process completed successfully; it does not prove the requested change is correct.

Capture a baseline before a run so pre-existing edits are not attributed to that task. For concurrent coding tasks, offer separate Git worktrees and show their branches clearly. Worktree management, result comparison, and review are substantial features and should follow reliable run records.

**Attention you can trust.** Separate task status from process status. Add “Starting,” “Running,” “Stopped,” and “Failed to start” first. Surface “Needs input,” “Waiting for approval,” and “Ready for review” only where a provider integration can substantiate them. A generic terminal cannot reliably infer these from silence. Provide an attention list and optional notifications that open the relevant task or pane.

**Recovery and persistent results.** The current terminal is reset on a new start, and running tasks return to Backlog after restart. Save transcripts or structured results per run. On reopening, identify interrupted work and offer “View last output,” “Resume” when supported by the CLI, or “Start a new run.” Preserve the distinction between a saved transcript and a still-running process. Make closing the app with active work an explicit, understandable choice.

**Task planning at useful scale.** Add text search, agent/project/status filters, priority, queue order, cancellation, duplicate task, reusable prompt templates, and archive/undo. A larger composer should support long requests and show the resolved launch context. Keep execution choices understandable: “Interactive” and “Run to completion,” with clear descriptions of what happens afterward.

**Discoverable speed.** A command palette can unify new task, switch project, focus session, find a task, toggle broadcast, change layout, and open settings. Show shortcuts in menus. Avoid taking over common terminal key combinations without a clear routing policy.

**Agent readiness.** On first use, guide the user through choosing a project, detecting installed CLIs, checking versions, verifying supported authentication status, and starting one task. An agent marked “available” currently means enabled in the catalog, not necessarily installed or authenticated. Keep custom CLI templates available under advanced setup.

**History with drill-down.** The current Usage screen records run counts, elapsed session time, and outcomes. It is not token, cost, or quota tracking. Rename it “Activity” or “Runs” until richer usage exists. Add searchable, paginated history: the current table limits display to 50 recent runs even though retention can be much larger. Link each record to its output and task. Only show cost/token data supplied by an integration, with “Unavailable” when absent. Evidence: [usage.ts:17](C:/Projects/agent-dev/src/usage.ts:17), [UsagePage.tsx:36](C:/Projects/agent-dev/src/UsagePage.tsx:36).

## Delivery sequence and acceptance criteria

**Pass 1 — trustworthy foundations.** Fix mixed-state Start all, broadcast result handling, task directory inheritance, backup validation, secret export defaults, and visible save failures. Add targeted tests for these behaviors, including malformed backups and failed native calls. Verify spawn, stop, restart, and queue transitions in the Tauri app.

**Pass 2 — visible polish.** Simplify global and pane controls; add focus mode, a resizable task rail, a wider composer, and keyboard menu behavior. Use seeded review fixtures to inspect empty, busy, failed, and long-content states. Check at 1280 × 820 (the configured desktop window), a smaller window, and a wide desktop, plus Windows scaling. No clipped critical actions or pane headers that consume multiple control rows.

**Pass 3 — complete the work loop.** Introduce project records, persistent run details/output, and the review surface. A completed task should remain understandable after restarting the app. A reviewer should be able to identify the request, output, changes, and test evidence without reconstructing a terminal session.

**Pass 4 — advanced coordination.** Add worktree isolation, provider-specific attention events, templates, dependency-aware queues, and measured usage. Implement window-state restoration and a signed update flow when distribution is in scope.

The architecture can evolve incrementally. App.tsx is about 1,474 lines and AgentPane.tsx about 937; extract focused persistence, scheduling, and session-lifecycle modules as these features are introduced. Decouple session identity and output from pane position before allowing live cross-column movement, which the current implementation deliberately blocks to avoid remounting the terminal.

Profile output throughput, memory at the pane cap, resize behavior, and history growth before selecting performance optimizations. The build warning alone is not evidence of poor runtime performance. Lazy-loading secondary pages may help startup, but session correctness and readable working space have higher immediate value.

**Best first implementation package:** reliability fixes, compact pane headers, contextual workspace controls, focus mode, and a better task composer. These changes would be visible immediately and establish the foundation for projects and review.

