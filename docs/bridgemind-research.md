# BridgeMind research — what the inspiration ships now

Researched 2026-10-01 from bridgemind.ai: the product page, pricing, the docs and
every BridgeMind One release note from v0.1.0 (Aug 20, 2026) to v0.3.0 (Oct 1,
2026), plus the last BridgeSpace releases. Sources are listed at the end.

The site refuses plain HTTP fetches (403). Read it through a real browser; each
release has its own page at `/changelog/bridgemind-one/vX-Y-Z`.

## 1. The product today

BridgeSpace, the BridgeMind product Crucible was modelled on, is discontinued. On
Aug 20, 2026 BridgeMind merged BridgeSpace, BridgeAgent and BridgeCode into one
desktop app, **BridgeMind One** ("the Agent Super App"), for Mac, Windows and
Linux. It shipped about 60 releases in six weeks.

- **Pricing:** Basic $20, Pro $50, Ultra $200 a month (20% off yearly). Each plan
  includes monthly credits (5,000 / 12,500 / 50,000) for hosted features: Auto
  runs, Create with AI, voice and cloud transcription. Credits do not roll over.
- **Bring your own AI:** the plan does not include Claude, Codex or Grok usage.
  You use your own subscriptions or API keys.
- Basic is the workspace alone. Pro and Ultra add voice and BridgeVerse.

A switch in the title bar moves the whole app between three modes:

- **Agent:** saved, named agents ("teammates"). Each has a written brief, a
  memory, reusable skills, a set of approved folders ("Places") and several chats,
  and can run on a schedule. The engine (Claude Code, Codex) powers the chats but
  does not define the teammate.
- **Code:** a canvas of real terminal panes over project folders. This is the part
  most like Crucible.
- **Thread:** a coding session shown as a chat conversation instead of a terminal.

### Agent mode in detail (from the docs)

| Part   | Purpose                                                      |
| ------ | ------------------------------------------------------------ |
| Name   | A recognizable identity in the roster, with a generated face |
| Brief  | The job, standards, tone and boundaries you define           |
| Memory | Durable facts and context the agent records for future work  |
| Skills | Reusable procedures the agent can follow and improve         |
| Places | Folders you explicitly approve for the agent's work          |
| Chats  | Separate conversation threads with the same teammate         |

- A good brief answers: what do you own, what context matters, what standards
  apply, and when should you stop and ask.
- **Memory** is for durable context: preferences, product decisions, recurring
  constraints, lessons that still matter next week. A Memory view lets you
  inspect and correct it. Settings choose a memory budget and a reflection mode.
  It is not a place for secrets or task-specific instructions.
- **Skills** say when they apply, the steps, what to verify and when to ask.
  There is a starter library, and agents can write or refine their own skills.
  Installing a starter skill syncs it to every coding-agent CLI on the machine.
- **Places, plugins, messaging and routine scheduling are separate
  permissions**, so a mistaken instruction has a limited reach.
- **Agent search:** `session_search` lets an agent search its own past chats
  (prose only, never tool calls or commands).
- **Create with AI** drafts a teammate's name and brief from a description.
- Changing a teammate's engine affects future work only.

## 2. Features by area

### Coordinating agents

- **Agent mail.** Agents send each other bounded messages and can @-mention one
  another from any composer. Messaging is granted per agent and can be paused
  app-wide. Each agent has an inbox of accepted messages. A message shows in both
  agents' chats as one line (sender, arrow, recipient) and can wake an idle
  teammate into a fresh chat. When a teammate replies, the original sender gets
  its last sent message back as context.
- **Handoff.** From a pane's menu, pass the conversation to another teammate. It
  opens beside the source with the transcript and your request as its first turn.
- **Routines.** A teammate runs on a daily, weekly or interval schedule, each run
  in a fresh chat. They only run while the app is open (no background service).
  Run now, Pause, Resume, Edit, Open last; errors show on the routine's row. The
  teammate must be allowed to schedule routines.
- **Auto modes.** From a pane's menu: Complete, Dream, Harden, Review or a custom
  task. The agent works through several turns; the header shows the mode, turn
  count and a progress ring, then a **Done** or **Stuck** verdict until dismissed.
- **Tasks.** Projects, labels, comments and history. Agents read and change tasks
  through a revocable MCP connection, which also works offline. A task can run in
  its own workspace with a separate review, saved progress and stop/resume. The
  voice assistant can create and run tasks.

### Launching agents

- **Launch presets:** Solo, Pair, Workbench, Swarm. Each seat has a role, and the
  lineup is previewed before anything spawns.
- **A worktree per agent.** Lanes are named from the task (`fix-auth`,
  `fix-auth-2`, on branch `one/<slug>`) and `.worktrees/` is excluded from the
  parent repo. Agents are told their branch, the repo and their siblings'
  branches before the task. A failed lane does not roll back the others ("Launch
  the N that worked").
- **Worktree lifecycle:** remove clean, unused lanes while keeping their branches,
  recover an interrupted creation, and sweep up leftovers.
- **Saved presets** can also seat plain terminals (with a command) and browsers.
- **In-app setup:** installs supported agent CLIs from a confirmed command in a
  visible terminal, and a Recheck button picks up a CLI installed mid-session.
- **Supported CLIs:** Claude Code, Codex, Cursor Agent, Gemini CLI, GitHub
  Copilot, Grok Build, Droid, OpenCode, Kimi Code, Amp, Antigravity, Aider, Muse
  Code. Thread mode talks to Cursor, Grok Build and OpenCode through the Agent
  Client Protocol.

### Seeing what agents are doing

- **Dashboard.** A card for every running agent: _Waiting for you_, _Working_,
  _Done_ or _Idle_ with elapsed time, what it is working on and its last line.
  Group by status or project, search (every word must match), **Close idle**
  (leaves working, waiting and done agents), full-screen card wall. Clicking a
  card flashes that agent's pane with a pulsing ring.
- **Approval list.** Any CLI blocked on a permission menu, trust prompt or
  approval (Claude Code, Codex, Gemini and others) shows as _Needs you_ and stays
  in a tray with its options until answered.
- **Desktop notifications** from Claude Code's hooks, for prompts, permission
  requests, questions, completion and failure. The hooks carry event types, not
  transcript text.
- **Plan usage:** Claude Code and Codex plan limits and reset times in the title
  bar; how full each agent's context window is in its pane header.
- **Usage dashboard** built from the local logs of seven agent CLIs, with a share
  card.
- **Teammate names** per pane that survive restarts; **Flip** turns every pane
  into a title card.
- **Approval cards** show the full command, with hidden characters spelled out and
  only secret values masked.

### Working beside the terminals

- **Side panel**, kept across modes: browser tabs with phone/tablet previews, a
  Files tab with an editor, Tasks, Scratchpad notes and focus timers.
- **Select element:** click part of a page in a browser tab and copy an
  agent-ready brief (HTML, selector, component, size, key styles).
- **Built-in git:** status in the file tree; stage, unstage, discard and commit
  with a diff per file; ahead/behind count; pull, push, publish.
- **Terminal shortcuts:** Ctrl-click a file path an agent printed to open it at
  that line; drop a file or folder on a terminal to type its quoted path; paste
  an image and it is saved as a file with its path typed for the agent.
- **Thread mode:** a Changes panel with a unified diff per file, inline Allow /
  Allow for session / Deny, plan mode with saved plan revisions, up to six
  threads side by side, pins and unread dots.
- **iOS Simulator** pane (Mac).

### Accounts and environments

- Several Claude Code and Codex accounts. At a usage limit, continue on another
  account through a confirmed context handoff.
- A resumed conversation runs under the account it was started on.
- Switch AI provider between turns and keep the conversation's context.
- Projects on a remote machine over SSH, or inside WSL (agents installed only
  inside WSL are detected and launched there).

### Reliability

- Session restore: layout, tabs and panes come back; terminals stay paused until
  you act (later: restarted in sequence).
- Asks before quitting while agents, terminals or tasks are running.
- **Review before you ship** (BridgeSpace 3.1.1): packages staged, unstaged and
  untracked changes into a read-only review prompt. Redacts secret-like values,
  blocks `.env`, credential and key paths, and treats every diff line as
  untrusted input.
- Signed auto-updates; a withdrawn release is rolled back and marked "Yanked".

### Pro-plan extras

- **Bridge**, a voice assistant that can drive the whole app ("Hey Bridge"), with
  its own memory; dictation with local models (Whisper, Apple Speech, Parakeet).
- **Plugins** (GitHub, Linear, Stripe, Vercel, Slack and more), enabled per
  agent; writes and spending need an approval card.
- Pairing an iPhone to control the app and answer agents' approvals.
- **BridgeVerse:** a 3D office where each project is a floor and each agent has a
  desk, with arcade games, experience points and a pet.
- Seven colour themes and a What's New screen.

### Look and feel (from the site's interactive demo)

The app itself is flat, dark and dense. The glows and light beams are on the
marketing site, not in the app.

- **Window:** a near-black, neutral-grey palette (not GitHub's blue-tinted
  dark), thin hairline borders, small type, generous use of muted grey for
  secondary text. Opens dark by default.
- **Title bar:** app name and a sidebar toggle on the left; a centred
  segmented control (Agent | Code | Thread); on the right, small icon buttons
  for the layout menu, the voice orb, the notification bell and the right sidebar.
- **Left rail:** a "Workspaces" list of project folders, each with a count
  badge, and the open panes nested beneath the active folder, each with a status
  dot. Folders pin and reorder by drag; long names truncate in the middle. The
  footer holds the account avatar, plan, credits, a light/dark switch and
  Settings.
- **Pane headers:** a liveness dot and the agent's mark first, then the folder
  (or branch, or token count); small icon actions at the right (⋯ menu,
  fullscreen, +, close). The full title lives in a tooltip, not the header. The
  focused pane has a soft accent outline. The footer shows "96% context left".
- **Right sidebar:** tabs (browser, Dashboard, Files, Tasks) that stay put across
  modes.
- **Dashboard:** three count tiles at the top (Needs you, Working, Idle), then
  grouped sections ("NEEDS YOU 1", "WORKING 2", "IDLE 1"). Each row has the
  agent's face or engine mark, the task title, a subtitle (agent or engine ·
  project), and a coloured status on the right with elapsed time: amber
  "Needs you 9m", green "Working 4m", grey "Idle". Clicking a row jumps to the
  agent's pane and flashes it.
- **Effects:** Liquid Glass menus on macOS, a glowing animated voice orb and a
  particle launch animation (skippable, with a Reduce Motion fade).

## 3. Where Crucible stands

Crucible already has: real terminal panes for any CLI on `PATH` with split
layouts and presets; a Kanban board with a queue, priorities, dependencies and a
concurrency limit; an optional worktree per task; saved output and a Git diff per
run; agent review with change requests; run history; a quit warning while agents
run; an attention flag from OSC 9; broadcast to several agents; a command palette.
The board is ahead of BridgeMind's on dependencies and queueing.

Gaps found while comparing:

- `create_worktree` exists, but nothing merges, removes or sweeps worktrees.
- The terminal's link handling (`WebLinksAddon`) covers URLs only.
- Attention comes only from OSC 9; there is no per-agent status model and no
  desktop notification.
- `AgentConfig` is a CLI entry, not a teammate: there is no brief, memory or
  identity that outlives a run.

## 4. Worth borrowing, best fit first

1. **A status for every agent, plus desktop notifications.** _Waiting for you_,
   _Working_, _Done_, _Idle_ with time in state. Claude Code's hooks report
   exactly when it needs input.
2. **Auto modes that end in a verdict.** The same idea as reading the reviewer's
   `APPROVE` / `REQUEST CHANGES` line, badging the reviewed task and pre-filling
   the change request.
3. **Worktree lifecycle**, then running one task on several agents in separate
   worktrees to compare.
4. **Handoff** to another agent. Prompts travel as argv, so write the context to
   a file and pass its path instead of embedding output.
5. **Terminal shortcuts:** file-path links, file drop, image paste.
6. **Multiple accounts** through per-agent env: Claude Code reads
   `CLAUDE_CONFIG_DIR`, Codex reads `CODEX_HOME` (untested here).
7. **Tasks over MCP** — the coordinator item from the README roadmap.
8. **Routines:** a scheduled task that queues a fresh headless copy of itself.
9. **Token counts from the CLIs' own logs** (measured, so allowed). Plan limits
   and reset times need provider servers; leave them out.

Not worth copying: voice, BridgeVerse and games, credits and plans, the plugin
marketplace, the phone app, an embedded browser.

## 5. Chosen direction (2026-10-01)

The owner picked:

- **Agent mode:** saved, named agents, each with a written brief, a memory,
  reusable skills, a set of approved folders and several chats, able to run on a
  schedule.
- **Per-agent memory and agent-to-agent messaging.** The reason: many of the
  owner's projects share tech stacks, so what an agent learns in one project
  should carry to the next.
- **Items 1 and 2** above: per-agent status with notifications, and runs that end
  in a verdict.
- **The Dashboard**, and BridgeMind's overall look and feel.

### Look and feel against Crucible's design rules

Most of BridgeMind's app look already fits the rules in `CLAUDE.md` ("UI
conventions"): dark, flat, dense, hairline borders, icon-only buttons, status
dots. Moving toward it is mostly layout and palette:

- a near-black neutral palette in place of GitHub's blue-tinted dark (token
  changes in `App.css` / `Premium.css`);
- a left rail of projects with their panes nested beneath, with status dots;
- slimmer pane headers that lead with a status dot and the agent's mark;
- a right sidebar whose first tab is the Dashboard.

The effects are what conflict with those rules: glass menus, the glowing orb and
the particle launch animation. Adopting them would mean changing the "no
gradients/glassmorphism" rule; that is the owner's call, and none of the chosen
features need them.

The Dashboard depends on item 1: its tiles and groups are the per-agent status
model (_Needs you_, _Working_, _Done_, _Idle_ with time in state). Build them
together.

### First thoughts on fitting it to Crucible (not a plan yet)

- **Teammate vs engine.** Add a teammate record (name, brief, memory, skills,
  places, schedule) that points at an `AgentConfig`. Changing the engine keeps the
  identity and memory, as in BridgeMind.
- **Memory belongs to the teammate, not the project.** That is what lets a
  lesson learned on one project reach another with the same stack. An open
  question is whether to also add a shared per-stack layer (e.g. "Tauri + React"
  notes) that every teammate on a project with that stack reads.
- **Getting memory into a run.** The argv rule forbids embedding large text in the
  prompt, so keep memory in a file under the app data directory and pass its
  path. Engine-specific routes to check: Claude Code's `--add-dir` and
  `--append-system-prompt`, Codex's `AGENTS.md`. The agent also needs a way to
  write memory back, and the owner a view to inspect and correct it.
- **Messaging needs a channel a CLI can use:** a file mailbox Crucible watches, or
  a local MCP server with `send_message` / `read_inbox` (which Tasks over MCP
  would later share). Safest delivery is a new headless task for the recipient,
  reusing the board, rather than typing into a live TUI (BridgeMind shipped
  several fixes for exactly that). Needs per-teammate permission, an app-wide
  pause, a loop limit, and every message visible in the UI.
- **Order.** Item 1 with the Dashboard first: messaging has to know whether the
  recipient is idle or waiting before it delivers. Then item 2, then teammates
  with brief and memory, then messaging, then routines. The look-and-feel changes
  can go alongside the Dashboard, since it introduces the right sidebar.

## Sources

- https://www.bridgemind.ai/ , /product , /pricing
- https://www.bridgemind.ai/changelog — every BridgeMind One release,
  v0.1.0–v0.3.0, at `/changelog/bridgemind-one/<version>`
- BridgeSpace releases 3.4.17, 3.4.13, 3.2.2, 3.1.1, 3.0.84 and 3.0.70 at
  `/changelog/bridgespace/<version>`
- https://docs.bridgemind.ai/docs/agent-mode , /code-mode , /chat-mode ,
  /routines , /skills-and-plugins
