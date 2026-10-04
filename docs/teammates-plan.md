# Implementation plan — Teammates with per-teammate memory

Status: implemented 2026-10-01 (see `docs/development-checkpoint.md`); the
memory file moved to a folder per run with messaging (`docs/messaging-plan.md`) · Direction: `docs/bridgemind-research.md`
section 5 (the owner chose saved, named agents with their own memory, so what
an agent learns on one project reaches the next; many projects share stacks).

## 1. What a teammate is

A saved, named agent: a **name**, the **engine** that runs it (an `AgentConfig`
from the catalog: Claude Code, Codex, any CLI), a written **brief** (what it
owns, its standards, when to stop and ask) and a **memory** it keeps itself.
Changing the engine keeps the name, brief and memory. Memory belongs to the
teammate, not the project, so it follows the teammate everywhere.

This pass covers teammates on **tasks**. Skills, approved folders, chats,
routines, messaging and starting a bare pane as a teammate come later.

## 2. User-visible behaviour

- **Teammates page** (header, between Workspace and Activity): a list of
  teammates and an editor for the selected one: name, engine, brief, and the
  memory itself — readable and editable, with its size and when it last changed,
  and **Clear memory**. **New teammate** and **Delete** (asks first; tasks that
  used it keep their engine).
- **Task composer**: the Agent picker becomes "Who does it", with a Teammates
  group (name · engine) above the Agents group. Choosing a teammate sets the
  task's engine to the teammate's.
- **Running a teammate's task**:
  1. Crucible writes the teammate's memory to `.crucible/memory/<slug>.md` in
     the run's folder (the project folder or the task's worktree) and adds
     `.crucible/` to the repository's `info/exclude`, so the file never shows
     in `git status`, run diffs or review file lists.
  2. The prompt sent is a short preface — "You are <name>…", the brief, where
     the memory file is and how to keep it — followed by the task's usual
     prompt. The run record stores exactly what was sent.
  3. When the run ends, Crucible reads the file back and merges it into the
     teammate's memory. A toast says the teammate updated its memory, with a
     link to it.
- Cards, task detail, the Dashboard and Activity name the teammate.

## 3. Rules

- **Argv safety.** The memory is agent-written and can hold anything, so it
  never travels as an argument; only its relative path does. The brief is the
  owner's own text, like a task prompt, and is capped (`BRIEF_MAX` = 2000).
- **Merge** (`mergeMemory`, pure): if the stored memory has not changed since
  the run started, the file's content replaces it, so the teammate can rewrite
  or prune its own notes. If it has changed (edited on the Teammates page, or
  another run merged first), only lines the run added are appended, so neither
  side's work is lost. A missing or unchanged file changes nothing.
- **Cap.** `MEMORY_MAX` = 16000 characters; past it the oldest lines are
  dropped and the toast says so.
- A run that is stopped still merges (it may have learned something); a run
  that failed to start has nothing to merge. Memory written by a run that is
  still going when Crucible closes is not collected.

## 4. Data model

- `src/teammates.ts` (new, pure): `Teammate { id, name, agentId, brief, memory,
memoryUpdatedAt?, createdAt }`, `normalizeTeammates`, `teammateNameError`,
  `memoryFileName`, `teammatePrompt`, `mergeMemory`, limits.
- `Workspace.teammates: Teammate[]` — normalized, `[]` when absent. Optional
  and additive, so no `STORAGE_KEY` bump (same as `dashboardOpen`); strict
  import rejects a `teammates` value that is not an array.
- `Task.teammateId?` and `TaskDraft.teammateId?` (composer-owned, so
  `draftFromTask` carries it); dropped on load when the teammate is gone.
- `RunRecord.teammateId?`, `teammateName?` (a snapshot, like `agentName`).

## 5. Native (`desktop.rs`)

- `seed_memory(cwd, file, content)`: validates the file name (lowercase
  slug + `.md`, no paths), writes `<cwd>/.crucible/memory/<file>` atomically,
  and when `cwd` is in a Git repository appends `.crucible/` to the file
  `git rev-parse --git-path info/exclude` names, once. Returns the relative
  path.
- `collect_memory(cwd, file)`: returns the file's text (read capped at
  256 KiB), or nothing when it is missing.
- Rust tests: file-name validation, the exclude line written once (also from a
  worktree), round trip, missing file.

## 6. Acceptance

- `npm test`: `tests/teammates.test.mjs` (prompt, merge cases, cap, names,
  normalization, task and run fields) passes with the rest.
- `npm run build` and `cargo test --offline` pass.
- Driven in the dev server with the IPC mock: create a teammate, run a task as
  it, see the seeded content and prompt, return an edited file, and see the
  memory merged and the toast; edit memory mid-run and see lines appended
  rather than replaced.
