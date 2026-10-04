# Implementation plan — Teammate messaging

Status: implemented 2026-10-03 (see `docs/development-checkpoint.md`) · Direction: `docs/bridgemind-research.md`
section 5 (the owner wants teammates that talk to each other: many projects
share a stack, so a lesson one teammate learns should reach the others) ·
Builds on `docs/teammates-plan.md`.

## 1. What a message is

A short note from one teammate (or the owner) to another: a lesson that
applies to the recipient's work, a question, or a request. It waits in the
recipient's **inbox** and is delivered at the start of the recipient's next
run. If the owner allows it, a message can also **start a task** for the
recipient right away.

## 2. The channel: files in the run's folder

Every CLI can read and write files, so messaging needs no MCP server and works
for any engine. Each teammate run gets its own folder,
`<run folder>/.crucible/<name>-<run id tail>/`, holding:

- `memory.md`: the teammate's memory (as before, now per run);
- `inbox.md`: the messages delivered to this run (only when there are any);
- `outbox.md`: empty; the teammate writes messages here, each under a
  `## To: <name>` line (`everyone` reaches every teammate).

A folder per run fixes a v0.6.0 bug: two runs of the same teammate in the
same folder shared one memory file, so the second seed overwrote the first
run's notes. The folder is removed after the run (v0.6.0 left the memory
file behind). `.crucible/` stays in the repository's `info/exclude`.

## 3. Rules

- **Argv safety.** Message bodies are agent-written and never travel as an
  argument. The prompt carries only fixed text, the run folder's relative
  path, teammate names (owner-written, validated) and a message count.
- **Sending.** Crucible reads the outbox when the run finishes a turn (the
  pane's activity leaves Working) and when the run ends. A message already
  sent from this run is not sent again (same recipient and text), so the
  teammate may keep or clear the file. Unknown names and messages to itself
  are reported, not sent. Limits: 4000 characters a message, 10 messages a
  run (each recipient counts).
- **Delivery.** At launch a teammate's waiting messages, oldest first, up to
  20, go into its `inbox.md`, and the prompt says how many there are. They
  are marked delivered once the process starts. For a reply, the inbox also
  quotes the recipient's own last message to that sender, for context.
- **Starting a task** (BridgeMind's "wake"): only when the recipient's
  setting is "Start a task", Settings → "Messages can start tasks" is on, and
  the message is within the chain limit. The task is headless, runs in the
  sender's folder (not isolated), carries the message ids, and asks the
  teammate to read its inbox and act. A waiting, unstarted message task for
  the same teammate in the same project gains the new message instead of a
  second task. The owner can start a task from any waiting message by hand.
- **Chain limit.** A message's `hop` is 1 when the owner wrote it or a run
  the owner started sent it, and one more than the task's `hop` when a
  message-started run sent it. Above `messageChainLimit` (default 3) a
  message waits instead of starting a task, and the toast says why.
- **Per teammate.** "Can message teammates" (default on; off removes the
  outbox and its instructions) and "When a message arrives": hold it for the
  next task (default) or start a task.
- **Owner messages.** The owner can write to a teammate from its page; the
  message follows the same delivery rules.

## 4. Data model

- `src/messages.ts` (new, pure): `TeamMessage { id, from, fromName, to, body,
at, projectId?, cwd?, runId?, hop, deliveredAt?, deliveredRunId?, taskId? }`
  (`from` is a teammate id or `"owner"`), `parseOutbox`, `inboxText`,
  `messagesToDeliver`, `messageTaskFor`, `normalizeMessages`,
  `retainMessages` (500 kept; delivered ones go first).
- `Workspace.messages`, `[]` when absent; strict import rejects a non-list.
  Messages to a teammate that no longer exists are dropped.
- `Teammate.canMessage`, `Teammate.onMessage: "hold" | "start"`.
- `Task.messageIds?`, `Task.hop?` (message tasks only; runtime-owned).
- `RunRecord.request?`: the task's own request when the prompt carries a
  teammate preface, so an agent review quotes the request, not the preface.
- `Settings.messageStarts` (default on), `Settings.messageChainLimit` (1–10,
  default 3).

## 5. Native (`desktop.rs`)

- `seed_teammate_run(cwd, folder, memory, inbox?, outbox)`: validates the
  folder name (`[a-z0-9-]`, 80 at most, no leading `-`), refuses a
  `.crucible` that resolves outside `cwd`, writes the files atomically, adds
  `.crucible/` to `info/exclude` once. Returns the relative folder.
- `collect_teammate_run(cwd, folder, remove)`: returns `{ memory, outbox }`
  (256 KiB read cap each, `None` when missing); with `remove`, deletes the
  three files, the folder and an empty `.crucible`. Seeding and removal hold
  one lock so a removal cannot race a seed.
- Replaces `seed_memory` / `collect_memory`.

## 6. UI

- Teammates page: a **Messages** block per teammate (both settings, a box to
  write to it, and its messages in and out, newest first, with Waiting /
  Delivered / Task started, **Start a task** and **Delete**). The list and the
  header's Teammates button show waiting counts.
- Toasts for sent messages (with **View** or **Open task**) and for
  undeliverable ones. Task detail lists a message task's messages.
- Settings → Task board: "Messages can start tasks", "Longest message chain".

## 7. Bugs fixed on the way

- Concurrent runs of one teammate overwrote each other's memory (section 2).
- Memory files were left in project folders after runs.
- A new-task draft and prompt templates lost their teammate on reload.
- An agent review of a teammate's task quoted the teammate preface as the
  "original request".
- The board's agent filter ignored a teammate's engine.

## 8. Acceptance

- `npm test` with `tests/messages.test.mjs` (parsing, delivery, inbox text,
  chain, normalization, retention) and updated teammate/workspace tests.
- `npm run build`, `cargo test --offline` (folder names, round trip with
  removal and exclusion, worktree, non-Git folder).
- Driven in the dev server with the IPC mock: Ada's run writes to Ben; Ben's
  next run is seeded with the message; a message to a "start" teammate starts
  a task that carries it; the chain stops at the limit; owner messages; the
  page's lists and counts.
