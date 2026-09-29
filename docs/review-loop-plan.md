# Implementation plan — Review loop (agent reviewers + change requests)

Status: implemented 2026-09-29 (see `docs/development-checkpoint.md`) · The feature itself is frontend only

## 1. Why this feature

The work loop today stops at a human reading a diff. Two gaps remain:

1. **"Request changes" goes nowhere.** It moves the card back to Backlog with
   `attention: "Changes requested"`, but the next run sends the _original_ prompt
   only. The reviewer's feedback never reaches the agent, so re-running repeats the
   same attempt.
2. **No second opinion.** The README roadmap names "roles (builder/reviewer)" as
   the next step. Crucible already has everything a reviewer agent needs: headless
   mode, per-run Git diffs (`read_run`), worktrees, and linked tasks. It has no way
   to hand a finished task to a different agent for review.

This pass closes both, with nothing new in the backend.

## 2. User-visible behaviour

**Change requests reach the next run.**

- In task detail, **Request changes** opens an inline form, "What needs to
  change?", prefilled with any pending request. It has two actions: **Send back and
  re-run** and **Send back to backlog**, plus Cancel.
- The text is stored on the task as `changeRequest`. Every launch of that task
  sends `launchPrompt(task)`: the original request, a blank line, the heading
  `Changes requested after review:`, and the feedback. The run record's `prompt`
  stores exactly what was sent, so history stays truthful.
- The request stays until the task is **Marked reviewed & done**, **Cleared**
  (a text button beside the pending request in task detail), or replaced by a
  new one. An empty form behaves like today: back to Backlog with no feedback.
- A card with a pending change request shows a `Changes` meta chip.

**Agent review.**

- Task detail (for any task that is not itself a review) gains an **Agent review**
  block. It has a reviewer `<select>` (enabled agents; the default is a different
  agent from the builder when one exists) and an **Ask for review** button.
  The button is disabled while the task is running, or before it has any run.
- Asking creates a new task `Review: <title>` in the same project. It is
  `mode: "headless"`, `isolation: false` (it must see the builder's files, never
  its own worktree), and its `cwd` is the builder's last run folder (or its
  worktree, then its own cwd). It carries `reviewOf: <builder task id>` and is
  started immediately; if no pane is free it queues like any task.
- The reviewer prompt holds the request that was sent to the builder, where to look
  (worktree → `git diff HEAD`, shared folder → `git diff` with a caveat), the
  changed file list captured for the builder's last run (capped), the builder's
  exit code, and the review instructions from Settings.
- The builder's detail lists its reviews (status, exit badge, created time, and an
  **Open** link). A review task's detail shows "Agent review of “X”" with a link
  back. Its card shows a `Review` meta chip.
- **Settings → Task board → Review instructions** is a textarea appended to every
  reviewer prompt. A blank value falls back to the built-in checklist, and a
  **Reset to default** button restores it.

### Safety constraint (important)

Prompts are passed as argv. On Windows, npm `.cmd` shims are launched through
`cmd.exe /c`, which does not honour MSVC `\"` escaping. The reviewer prompt
therefore must **never embed diff text or agent output**. It may contain only
fixed text, the user's own request and change request, file paths (Windows paths
cannot contain `"`), status words, and an exit code. Strip control characters from
paths and truncate each one. (The same pass also stopped routing npm shims
through `cmd.exe`; this rule stays, because other batch agents and the 32 KiB
argv limit still apply.)

## 3. Data model (pure modules)

### `src/tasks.ts`

```ts
// on Task
/** Feedback from "Request changes"; appended to every launch prompt until the
 *  task is marked done or the request is cleared. */
changeRequest?: string;
/** On an agent-review task: the id of the task whose work it reviews. */
reviewOf?: string;

export const CHANGE_REQUEST_HEADING = "Changes requested after review:";
/** The prompt a launch actually sends. Every launch path must use this, never
 *  `task.prompt` directly. */
export function launchPrompt(task: Pick<Task, "prompt" | "changeRequest">): string;
// blank/whitespace changeRequest → task.prompt unchanged (identity)
// else `${task.prompt.trimEnd()}\n\n${CHANGE_REQUEST_HEADING}\n${changeRequest.trim()}`
```

`draftFromTask` stays a whitelist, so it must not carry either new field. Pin
that with a test.

### `src/settings.ts`

- `reviewInstructions: string` on `Settings`, in the Task board group.
- `export const DEFAULT_REVIEW_INSTRUCTIONS`: a short checklist asking whether the
  change does what was requested, and checking for bugs, regressions, missing tests
  and unsafe edge cases. It says to run the project's quick checks if cheap, and
  to finish with a verdict line `APPROVE` or `REQUEST CHANGES` followed by the
  specific changes needed.
- `export const REVIEW_INSTRUCTIONS_MAX = 4000`.
- `normalizeSettings`: non-string → default; string → `slice(0, MAX)`. Keep an
  empty string as-is; the builder falls back.

### `src/review.ts` (new, pure; no React, no Tauri)

```ts
export interface ReviewFile {
  path: string;
  status: string;
}
export const REVIEW_FILE_LIMIT = 40;
export const REVIEW_PATH_LIMIT = 200;
export interface ReviewContext {
  task: Task; // the task under review
  builderName: string;
  run?: RunRecord; // its latest finished run, if any
  files?: ReviewFile[]; // undefined = no capture available
  instructions: string; // settings.reviewInstructions
}
export function buildReviewPrompt(ctx: ReviewContext): string;
export function reviewTaskFor(
  task: Task,
  run: RunRecord | undefined,
  reviewerAgentId: string,
  prompt: string,
  ids: { id: string; now: number },
): Task;
export function pickReviewer(
  agents: AgentConfig[],
  builderAgentId: string,
): string | undefined;
export function reviewsOf(tasks: Task[], taskId: string): Task[];
```

`buildReviewPrompt` sections, in order:

1. `Review the work another coding agent (<builderName>) did for the task below.`
   followed by an instruction not to modify, create or delete files, or commit.
2. `Task: <title>`
3. `Original request:` then `run?.prompt || launchPrompt(task)`
4. `Where to look:` — if `task.worktree` is set, an isolated-worktree line
   (`git status`, `git diff HEAD`, include untracked files). Otherwise a
   shared-folder line (`git status`, `git diff`; pre-existing edits may appear,
   so focus on the listed files).
5. The files line depends on `files`:
   - `undefined`: "No file list was captured for this run; inspect the working tree directly."
   - empty: "The run's snapshot recorded no text-file changes; check whether the request was carried out."
   - otherwise: `Files changed during the run (N):` then `- <status>: <path>` for at
     most `REVIEW_FILE_LIMIT`, then `- …and K more`.
   - Status is one of added/modified/deleted, else `changed`.
   - Each path has control chars `[\u0000-\u001f\u007f]` removed and is truncated to
     `REVIEW_PATH_LIMIT` with `…`.
6. The exit line depends on the run:
   - `run.exitCode` is a number: `The builder's process exited with code N.`
   - else, if `run` exists: `The builder's run ended as: <outcome>.`
   - else: omitted.
7. `Review instructions:` then `instructions.trim() || DEFAULT_REVIEW_INSTRUCTIONS`.

Only `path` and `status` are ever read from `files`. Extra properties, such as a
`diff`, must never leak into the prompt.

`reviewTaskFor` returns:

```ts
{
  id, title: `Review: ${task.title}`, prompt, agentId: reviewerAgentId,
  cwd: run?.cwd || task.worktree || task.cwd || undefined,
  mode: "headless", status: "backlog",
  projectId: task.projectId, priority: task.priority ?? "normal",
  createdAt: now, reviewOf: task.id, isolation: false, dependencies: [],
}
```

`pickReviewer` works over enabled agents. It returns the first one whose id differs
from the builder's. If there is none, it returns the builder's agent if enabled,
then the first enabled agent, then `undefined`.

`reviewsOf` returns non-archived tasks with `reviewOf === taskId`, in array order.

### `src/workspace.ts` — `normalizeWorkspace`

- `changeRequest`: kept when it is a string with non-blank content, else `undefined`.
- `reviewOf`: kept when it is a string. In the same post-pass that filters
  `dependencies`, drop it if it is dangling or equals the task's own id.
  Tolerant in strict mode too, since a dangling link is not a corrupt backup.
- No `STORAGE_KEY` bump. These are optional, additive fields that normalization
  tolerates in both directions. The top-level `Workspace` shape is unchanged.

## 4. App wiring (`src/App.tsx`)

- `createRun`: `prompt: task ? launchPrompt(task) : undefined`.
- `startTask`: `seedArgs(a, launchPrompt(task), task.mode, state.settings)`.
- **Mark reviewed & done** (`onReview`) also clears `changeRequest`.
- `duplicateTask` resets `changeRequest` and `reviewOf`.
- New `requestReview(taskId, reviewerId)`. It returns early if the task is missing
  or running, and notifies if the reviewer is missing or disabled. It finds the
  latest non-running run for the task in `usage`, then fetches its review with
  `invoke<ReviewData>("read_run", { runId, refresh: false })`. If that works and
  `review.git` is true, it maps to `{path, status}`; otherwise `files` stays
  undefined, and a thrown error is not fatal. It then builds the prompt and the
  review task, appends the task via `change`, notifies with an "Open review"
  action, and calls `startTask(review.id)`. Guard `invoke` with `isTauri()` like
  the rest of App.
- New `onRequestChanges(feedback, rerun)` handler, passed to TaskDetail. It patches
  `changeRequest` (trimmed, or undefined when blank), `attention: "Changes requested"`,
  `status: "backlog"`, `reviewedAt: undefined` and `interrupted: false`, and then
  optionally calls `startTask`.
- TaskDetail gets new props: `agents` (enabled), `reviews`, `reviewedTask`,
  `onRequestReview`, `onRequestChanges`, `onOpenTask` (uses `showTask`).

## 5. UI

- `src/TaskDetail.tsx`: the inline change-request form, the pending-request
  display with a Clear button, the Agent review block with its linked-review list,
  and the "review of" backlink. Reuse existing classes (`detail-actions`,
  `review-notes`, `request-view`, `attempt-picker`, `outcome <status>`, `muted`,
  `text-button`, `btn`).
- `src/TaskBoard.tsx`: `Review` and `Changes` chips in `.task-item-meta`.
- `src/SettingsPage.tsx`: a Review instructions row in the Task board section,
  with a labelled textarea and a Reset to default button.
- `src/Premium.css`: minimal rules for the review list or the settings textarea,
  only if existing classes don't cover them. Use tokens only; no new colours.
  Keep `:focus-visible` coverage.

## 6. Work breakdown (delegated)

| Step             | Owner        | Files                                                                                                       | Depends on          |
| ---------------- | ------------ | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| A. Model + tests | Sonnet agent | `src/tasks.ts`, `src/settings.ts`, `src/review.ts` (new), `src/workspace.ts`, `tests/review.test.mjs` (new) | —                   |
| B. UI + wiring   | Sonnet agent | `src/App.tsx`, `src/TaskDetail.tsx`, `src/TaskBoard.tsx`, `src/SettingsPage.tsx`, `src/Premium.css`         | A                   |
| C. Docs          | Sonnet agent | `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/development-checkpoint.md`                                     | A (parallel with B) |
| D. Verify + ship | Lead         | review diff, `npm test`, `npm run build`, browser smoke check, Prettier, commit, push                       | B, C                |

## 7. Acceptance

- `npm test` passes, with new coverage for `launchPrompt`, `draftFromTask`
  exclusion, `buildReviewPrompt` (sections, caps, sanitising, no diff leak),
  `reviewTaskFor`, `pickReviewer`, `reviewsOf`, workspace normalization of both
  fields, and settings normalization.
- `npm run build` passes: strict `tsc`, no unused locals or params.
- Prettier 3.6.2 has been run over the changed files.
- In the vite dev server, the Settings page renders the new row, and task detail
  renders the review block and the change-request form without console errors.
  The native launch path is unchanged apart from the prompt string.
