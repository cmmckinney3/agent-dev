import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { pureModules } from "./modules.mjs";

// Exercise the actual pure TypeScript models without adding a browser test runtime.
const temp = mkdtempSync(join(tmpdir(), "crucible-review-tests-"));
for (const name of pureModules()) {
  const source = readFileSync(
    new URL(`../src/${name}.ts`, import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  });
  writeFileSync(
    join(temp, `${name}.mjs`),
    outputText.replace(/from "\.\/([^"]+)"/g, 'from "./$1.mjs"'),
  );
}
const { normalizeWorkspace } = await import(
  pathToFileURL(join(temp, "workspace.mjs"))
);
const { launchPrompt, draftFromTask, CHANGE_REQUEST_HEADING } = await import(
  pathToFileURL(join(temp, "tasks.mjs"))
);
const {
  DEFAULT_SETTINGS,
  DEFAULT_REVIEW_INSTRUCTIONS,
  REVIEW_INSTRUCTIONS_MAX,
  normalizeSettings,
} = await import(pathToFileURL(join(temp, "settings.mjs")));
const {
  buildReviewPrompt,
  reviewTaskFor,
  pickReviewer,
  reviewsOf,
  REVIEW_FILE_LIMIT,
  REVIEW_PATH_LIMIT,
  parseVerdict,
  plainOutput,
  changeRequestFrom,
} = await import(pathToFileURL(join(temp, "review.mjs")));
const { VERDICT_SUMMARY_MAX } = await import(
  pathToFileURL(join(temp, "tasks.mjs"))
);
after(() => {
  if (
    resolve(temp).startsWith(resolve(tmpdir()) + "\\") ||
    resolve(temp).startsWith(resolve(tmpdir()) + "/")
  )
    rmSync(temp, { recursive: true });
});
const task = (id, patch = {}) => ({
  id,
  title: id,
  prompt: "Do work",
  agentId: "codex",
  mode: "headless",
  status: "backlog",
  ...patch,
});
const run = (patch = {}) => ({
  id: "run-1",
  agentId: "codex",
  agentName: "Codex",
  slotId: "s",
  session: "S",
  startedAt: 1,
  outcome: "completed",
  ...patch,
});
const review = (patch = {}) =>
  buildReviewPrompt({
    task: task("t1", { title: "Add login" }),
    builderName: "Codex",
    instructions: "",
    ...patch,
  });
const file = (path, status = "modified") => ({ path, status });

test("launchPrompt sends the prompt unchanged unless feedback is pending", () => {
  assert.equal(launchPrompt({ prompt: "Do work" }), "Do work");
  for (const changeRequest of ["", "  \n\t "])
    assert.equal(
      launchPrompt({ prompt: "Do work\n", changeRequest }),
      "Do work\n",
    );
  assert.equal(
    launchPrompt({
      prompt: "Do work\n\n",
      changeRequest: "  Handle empty input\n",
    }),
    `Do work\n\n${CHANGE_REQUEST_HEADING}\nHandle empty input`,
  );
  assert.equal(CHANGE_REQUEST_HEADING, "Changes requested after review:");
});
test("drafts ignore review fields, so a template cannot revive feedback or a review link", () => {
  const draft = draftFromTask(
    task("t1", { changeRequest: "Fix it", reviewOf: "t0" }),
  );
  assert.equal("changeRequest" in draft, false);
  assert.equal("reviewOf" in draft, false);
});
test("review prompt names the builder, the task and the request in order", () => {
  const p = review();
  assert.equal(
    p.split("\n\n")[0],
    "Review the work another coding agent (Codex) did for the task below. Do not modify, create or delete files and do not commit — report findings only.",
  );
  const order = [
    "Task: Add login",
    "Original request:\nDo work",
    "Where to look:",
    "No file list was captured",
    "Review instructions:",
  ].map((s) => p.indexOf(s));
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.ok(p.split("\n\n").includes("Task: Add login"));
});
test("review prompt shows what was actually sent to the builder", () => {
  const t = task("t1", {
    prompt: "Do work",
    changeRequest: "Cover the error path",
  });
  assert.match(
    review({ task: t, run: run({ prompt: "Sent prompt" }) }),
    /Original request:\nSent prompt\n\n/,
  );
  assert.doesNotMatch(
    review({ task: t, run: run({ prompt: "Sent prompt" }) }),
    /Cover the error path/,
  );
  for (const r of [undefined, run(), run({ prompt: "" })])
    assert.match(
      review({ task: t, run: r }),
      new RegExp(
        `Original request:\\nDo work\\n\\n${CHANGE_REQUEST_HEADING}\\nCover the error path\\n\\n`,
      ),
    );
});
test("a teammate's preface is not quoted to the reviewer as the request", () => {
  const p = review({
    run: run({
      prompt: "You are Ada, a teammate…\n\nTask:\nAdd the login form",
      request: "Add the login form",
    }),
  });
  assert.match(p, /Original request:\nAdd the login form\n\n/);
  assert.doesNotMatch(p, /You are Ada/);
});
test("review prompt points at the worktree or warns about the shared folder", () => {
  const isolated = review({ task: task("t1", { worktree: "C:\\wt" }) });
  assert.match(isolated, /isolated Git worktree/);
  assert.match(isolated, /git diff HEAD/);
  assert.match(isolated, /untracked/);
  const shared = review();
  assert.match(shared, /shared project folder/);
  assert.match(shared, /git diff\./);
  assert.match(shared, /already there/);
  assert.doesNotMatch(shared, /git diff HEAD/);
  assert.doesNotMatch(isolated, /already there/);
});
test("review prompt handles a missing, empty and populated file list", () => {
  assert.match(
    review({ files: undefined }),
    /No file list was captured for this run; inspect the working tree directly\./,
  );
  const empty = review({ files: [] });
  assert.match(
    empty,
    /The run's snapshot recorded no text-file changes; check whether the request was carried out\./,
  );
  assert.doesNotMatch(empty, /Files changed/);
  const some = review({
    files: [
      file("src/a.ts", "added"),
      file("src/b.ts"),
      file("src/c.ts", "deleted"),
    ],
  });
  assert.match(
    some,
    /Files changed during the run \(3\):\n- added: src\/a\.ts\n- modified: src\/b\.ts\n- deleted: src\/c\.ts\n\n/,
  );
  assert.doesNotMatch(some, /No file list/);
});
test("review prompt caps a long file list and counts the rest", () => {
  const files = Array.from({ length: REVIEW_FILE_LIMIT + 5 }, (_, i) =>
    file(`f${i}.ts`),
  );
  const p = review({ files });
  assert.match(
    p,
    new RegExp(`Files changed during the run \\(${REVIEW_FILE_LIMIT + 5}\\):`),
  );
  assert.equal(
    p.split("\n").filter((l) => l.startsWith("- modified: ")).length,
    REVIEW_FILE_LIMIT,
  );
  assert.ok(
    p.includes(`- modified: f${REVIEW_FILE_LIMIT - 1}.ts\n- …and 5 more\n`),
  );
  assert.ok(!p.includes(`f${REVIEW_FILE_LIMIT}.ts`));
  assert.ok(
    !review({ files: files.slice(0, REVIEW_FILE_LIMIT) }).includes("…and"),
  );
});
test("review prompt reports an unknown status as changed", () => {
  const p = review({ files: [file("a.ts", "renamed"), file("b.ts", "")] });
  assert.match(p, /- changed: a\.ts\n- changed: b\.ts\n/);
});
test("review prompt strips control characters and truncates long paths", () => {
  const p = review({
    files: [
      file("src/a\nb\u001b[31mc\u0000.ts"),
      file("x".repeat(REVIEW_PATH_LIMIT * 3)),
    ],
  });
  assert.ok(p.includes("- modified: src/ab[31mc.ts\n"));
  assert.doesNotMatch(p, /[\u0000-\u0009\u000b-\u001f\u007f]/);
  const long = p.split("\n").find((l) => l.startsWith("- modified: x"));
  assert.equal(long, `- modified: ${"x".repeat(REVIEW_PATH_LIMIT - 1)}…`);
  assert.ok(
    review({ files: [file("y".repeat(REVIEW_PATH_LIMIT))] }).includes(
      `- modified: ${"y".repeat(REVIEW_PATH_LIMIT)}\n`,
    ),
  );
});
test("review prompt never leaks diff text from file entries", () => {
  const p = review({
    files: [{ path: "a.ts", status: "modified", diff: "SECRET-DIFF-TEXT" }],
  });
  assert.ok(p.includes("- modified: a.ts"));
  assert.ok(!p.includes("SECRET-DIFF-TEXT"));
  // Not even read: only path and status may be touched.
  const guarded = {
    path: "b.ts",
    status: "added",
    get diff() {
      throw new Error("diff was read");
    },
    get output() {
      throw new Error("output was read");
    },
  };
  assert.ok(review({ files: [guarded] }).includes("- added: b.ts"));
});
test("review prompt carries no double quote of its own, since prompts travel as argv", () => {
  const p = review({
    run: run({ exitCode: 1 }),
    files: [file("a.ts")],
    task: task("t1", { worktree: "C:\\wt" }),
  });
  assert.ok(!p.includes('"'));
  assert.ok(!DEFAULT_REVIEW_INSTRUCTIONS.includes('"'));
});
test("review prompt reports the exit code, the outcome, or neither", () => {
  assert.match(
    review({ run: run({ exitCode: 0 }) }),
    /\n\nThe builder's process exited with code 0\.\n\n/,
  );
  assert.match(review({ run: run({ exitCode: 2 }) }), /exited with code 2\./);
  const stopped = review({ run: run({ outcome: "stopped" }) });
  assert.match(stopped, /\n\nThe builder's run ended as: stopped\.\n\n/);
  assert.doesNotMatch(stopped, /exited with code/);
  const none = review();
  assert.doesNotMatch(none, /The builder's (process|run)/);
  assert.ok(
    none.indexOf("Review instructions:") > none.indexOf("No file list"),
  );
});
test("review instructions fall back to the checklist when blank and are otherwise used verbatim", () => {
  for (const instructions of ["", "  \n\t "])
    assert.ok(
      review({ instructions }).endsWith(
        `Review instructions:\n${DEFAULT_REVIEW_INSTRUCTIONS}`,
      ),
    );
  const custom = review({
    instructions: "  Be strict about tests.\nCheck types.\n  ",
  });
  assert.ok(
    custom.endsWith(
      "Review instructions:\nBe strict about tests.\nCheck types.",
    ),
  );
  assert.ok(!custom.includes(DEFAULT_REVIEW_INSTRUCTIONS));
});
test("review task is a headless, non-isolated card linked to the task under review", () => {
  const t = task("task-1", {
    title: "Add login",
    projectId: "project-1",
    priority: "high",
    cwd: "C:\\Task",
    worktree: "C:\\Task\\wt",
    isolation: true,
    dependencies: ["task-0"],
    changeRequest: "Fix it",
    status: "review",
  });
  assert.deepEqual(
    reviewTaskFor(t, run({ cwd: "C:\\Run" }), "claude", "PROMPT", {
      id: "task-2",
      now: 99,
    }),
    {
      id: "task-2",
      title: "Review: Add login",
      prompt: "PROMPT",
      agentId: "claude",
      cwd: "C:\\Run",
      mode: "headless",
      status: "backlog",
      projectId: "project-1",
      priority: "high",
      createdAt: 99,
      reviewOf: "task-1",
      isolation: false,
      dependencies: [],
    },
  );
  assert.equal(
    reviewTaskFor(task("a"), undefined, "claude", "P", { id: "b", now: 1 })
      .priority,
    "normal",
  );
});
test("review task works in the run folder, then the worktree, then the task folder", () => {
  const cwd = (t, r) =>
    reviewTaskFor(t, r, "claude", "P", { id: "b", now: 1 }).cwd;
  const t = task("a", { cwd: "C:\\Task", worktree: "C:\\wt" });
  assert.equal(cwd(t, run({ cwd: "C:\\Run" })), "C:\\Run");
  assert.equal(cwd(t, run()), "C:\\wt");
  assert.equal(cwd(t, run({ cwd: "" })), "C:\\wt");
  assert.equal(cwd(t, undefined), "C:\\wt");
  assert.equal(cwd(task("a", { cwd: "C:\\Task" }), run()), "C:\\Task");
  assert.equal(cwd(task("a"), run()), undefined);
  assert.equal(cwd(task("a", { cwd: "" }), undefined), undefined);
});
test("reviewer defaults to a different enabled agent", () => {
  const agents = [
    { id: "claude", enabled: true },
    { id: "off", enabled: false },
    { id: "codex", enabled: true },
    { id: "gemini", enabled: true },
  ];
  assert.equal(pickReviewer(agents, "claude"), "codex");
  assert.equal(pickReviewer(agents, "codex"), "claude");
  assert.equal(pickReviewer(agents, "missing"), "claude");
  assert.equal(
    pickReviewer(
      [
        { id: "off", enabled: false },
        { id: "codex", enabled: true },
        { id: "claude", enabled: true },
      ],
      "off",
    ),
    "codex",
  );
});
test("reviewer falls back to the builder when it is the only agent enabled", () => {
  assert.equal(
    pickReviewer(
      [
        { id: "claude", enabled: true },
        { id: "codex", enabled: false },
      ],
      "claude",
    ),
    "claude",
  );
  assert.equal(
    pickReviewer(
      [
        { id: "claude", enabled: false },
        { id: "codex", enabled: true },
      ],
      "claude",
    ),
    "codex",
  );
  assert.equal(
    pickReviewer([{ id: "claude", enabled: false }], "claude"),
    undefined,
  );
  assert.equal(pickReviewer([], "claude"), undefined);
});
test("reviewsOf lists live reviews of one task in board order", () => {
  const tasks = [
    task("a"),
    task("r2", { reviewOf: "a" }),
    task("r1", { reviewOf: "b" }),
    task("r3", { reviewOf: "a", archived: true }),
    task("r0", { reviewOf: "a", status: "done" }),
  ];
  assert.deepEqual(
    reviewsOf(tasks, "a").map((t) => t.id),
    ["r2", "r0"],
  );
  assert.deepEqual(
    reviewsOf(tasks, "b").map((t) => t.id),
    ["r1"],
  );
  assert.deepEqual(reviewsOf(tasks, "none"), []);
});
test("workspace keeps a valid change request and review link", () => {
  const w = normalizeWorkspace({
    agents: [],
    tasks: [
      task("a"),
      task("b", { reviewOf: "a", changeRequest: "  Fix it\n" }),
    ],
  });
  assert.equal(w.tasks[1].reviewOf, "a");
  assert.equal(w.tasks[1].changeRequest, "  Fix it\n");
  assert.equal(w.tasks[0].reviewOf, undefined);
  assert.equal(w.tasks[0].changeRequest, undefined);
});
test("workspace drops dangling and self review links, and blank or malformed requests", () => {
  const w = normalizeWorkspace({
    agents: [],
    tasks: [
      task("a", { reviewOf: "gone" }),
      task("b", { reviewOf: "b" }),
      task("c", { reviewOf: "" }),
      task("d", { reviewOf: 7, changeRequest: 42 }),
      task("e", { changeRequest: " \n\t" }),
      task("f", { changeRequest: "" }),
    ],
  });
  for (const t of w.tasks) {
    assert.equal(t.reviewOf, undefined, t.id);
    assert.equal(t.changeRequest, undefined, t.id);
  }
});
test("workspace review fields survive a strict round trip, and a dangling link is not a corrupt backup", () => {
  const w = normalizeWorkspace({
    agents: [],
    tasks: [task("a"), task("b", { reviewOf: "a", changeRequest: "Fix it" })],
  });
  const back = normalizeWorkspace(JSON.parse(JSON.stringify(w)), true);
  assert.equal(back.tasks[1].reviewOf, "a");
  assert.equal(back.tasks[1].changeRequest, "Fix it");
  assert.doesNotThrow(() =>
    normalizeWorkspace(
      { agents: [], tasks: [task("a", { reviewOf: "gone" })] },
      true,
    ),
  );
  assert.equal(
    normalizeWorkspace(
      { agents: [], tasks: [task("a", { reviewOf: "gone" })] },
      true,
    ).tasks[0].reviewOf,
    undefined,
  );
});
test("review instructions default when missing or not a string, and are capped", () => {
  assert.equal(
    DEFAULT_SETTINGS.reviewInstructions,
    DEFAULT_REVIEW_INSTRUCTIONS,
  );
  assert.ok(DEFAULT_REVIEW_INSTRUCTIONS.length < 600);
  assert.match(DEFAULT_REVIEW_INSTRUCTIONS, /APPROVE or REQUEST CHANGES/);
  for (const raw of [
    undefined,
    null,
    {},
    { reviewInstructions: 5 },
    { reviewInstructions: null },
    { reviewInstructions: ["x"] },
  ])
    assert.equal(
      normalizeSettings(raw).reviewInstructions,
      DEFAULT_REVIEW_INSTRUCTIONS,
    );
  assert.equal(REVIEW_INSTRUCTIONS_MAX, 4000);
  assert.equal(
    normalizeSettings({
      reviewInstructions: "x".repeat(REVIEW_INSTRUCTIONS_MAX + 500),
    }).reviewInstructions,
    "x".repeat(REVIEW_INSTRUCTIONS_MAX),
  );
  assert.equal(
    normalizeSettings({ reviewInstructions: "Custom" }).reviewInstructions,
    "Custom",
  );
  assert.equal(
    normalizeSettings({ reviewInstructions: "" }).reviewInstructions,
    "",
  );
  assert.equal(
    normalizeWorkspace({ agents: [], settings: { reviewInstructions: "" } })
      .settings.reviewInstructions,
    "",
  );
});

// ---- Verdicts -------------------------------------------------------------

test("verdict: a plain Claude-style answer with findings after the line", () => {
  const output = [
    "The change fixes the clock but the regression test is missing.",
    "",
    "REQUEST CHANGES",
    "1. Add a test for the cancelled tier.",
    "",
    "2. Rename `t` to `tier`.",
  ].join("\n");
  assert.deepEqual(parseVerdict(output), {
    decision: "changes",
    summary:
      "1. Add a test for the cancelled tier.\n\n2. Rename `t` to `tier`.",
  });
});

test("verdict: Markdown decoration, a Verdict label and an inline reason", () => {
  assert.deepEqual(
    parseVerdict("## Review\nok\n\n**Verdict: APPROVE** — clean and tested."),
    {
      decision: "approve",
      summary: "clean and tested.",
    },
  );
  assert.deepEqual(parseVerdict("Verdict: request changes: add a test"), {
    decision: "changes",
    summary: "add a test",
  });
  assert.equal(parseVerdict("> APPROVED").decision, "approve");
  assert.equal(
    parseVerdict("- CHANGES REQUESTED\n- fix it").decision,
    "changes",
  );
  assert.equal(parseVerdict("### Final verdict: Approve").decision, "approve");
});

test("verdict: prose that merely starts with the word is not a verdict", () => {
  assert.equal(parseVerdict("Approve the PR once the tests pass."), undefined);
  assert.equal(
    parseVerdict("Request changes from the author if needed."),
    undefined,
  );
  assert.equal(parseVerdict("I would APPROVE this."), undefined);
  assert.equal(parseVerdict("APPROVES nothing"), undefined);
  assert.equal(parseVerdict(""), undefined);
});

test("verdict: the last verdict line wins", () => {
  const output =
    "REQUEST CHANGES\n- fix it\n\nUpdated after rerunning tests.\nAPPROVE";
  assert.equal(parseVerdict(output).decision, "approve");
});

test("verdict: real Codex exec output, prompt echo and token footer included", () => {
  const prompt =
    "Review the work.\nREQUEST CHANGES if anything fails.\nFinish with a verdict line, APPROVE or REQUEST CHANGES.";
  const output = [
    "OpenAI Codex v0.159.3",
    "--------",
    "workdir: C:\Demo",
    "--------",
    "user",
    "Review the work.",
    "REQUEST CHANGES if anything fails.",
    "Finish with a verdict line, APPROVE or REQUEST CHANGES.",
    "codex",
    "Finding: A test is missing.",
    "REQUEST CHANGES",
    "- add a test",
    "tokens used",
    "7,189",
    "Finding: A test is missing.",
    "REQUEST CHANGES",
    "- add a test",
  ].join("\r\n");
  assert.deepEqual(parseVerdict(output, prompt), {
    decision: "changes",
    summary: "- add a test",
  });
  // The stderr copy alone: findings stop at the footer.
  const stderrOnly = output.split("\r\n").slice(0, 14).join("\n");
  assert.deepEqual(parseVerdict(stderrOnly, prompt), {
    decision: "changes",
    summary: "- add a test",
  });
  // A bare verdict at the very end borrows the block before it, back to a marker.
  const bare = [...output.split("\r\n").slice(0, 12), "REQUEST CHANGES"].join(
    "\n",
  );
  assert.deepEqual(parseVerdict(bare, prompt), {
    decision: "changes",
    summary: "Finding: A test is missing.\nREQUEST CHANGES\n- add a test",
  });
  // Without the prompt, its echoed line would have looked like a verdict.
  const echoOnly = output.split("\r\n").slice(0, 8).join("\n");
  assert.equal(parseVerdict(echoOnly, prompt), undefined);
  assert.equal(parseVerdict(echoOnly).decision, "changes");
});

test("verdict: terminal escapes are stripped and findings are capped", () => {
  const colored =
    "\x1b[1m\x1b[32mAPPROVE\x1b[0m\r\n\x1b]0;title\x07Looks good.\x07";
  assert.deepEqual(parseVerdict(colored), {
    decision: "approve",
    summary: "Looks good.",
  });
  const long = parseVerdict(
    `REQUEST CHANGES\n${"x".repeat(VERDICT_SUMMARY_MAX * 2)}`,
  );
  assert.equal(long.summary.length, VERDICT_SUMMARY_MAX);
  assert.ok(long.summary.endsWith("…"));
  assert.equal(plainOutput("a\rb\r\nc\x1b[2Kd"), "a\nb\ncd");
});

test("verdict: a bare APPROVE with nothing around it has empty findings", () => {
  assert.deepEqual(parseVerdict("APPROVE"), {
    decision: "approve",
    summary: "",
  });
});

test("change request prefill keeps a pending request and avoids repeats", () => {
  const verdict = { summary: "- add a test" };
  assert.equal(changeRequestFrom(undefined, verdict), "- add a test");
  assert.equal(changeRequestFrom("  ", verdict), "- add a test");
  assert.equal(
    changeRequestFrom("Use the fixed clock", verdict),
    "Use the fixed clock\n\n- add a test",
  );
  assert.equal(
    changeRequestFrom("Use the fixed clock\n\n- add a test", verdict),
    "Use the fixed clock\n\n- add a test",
  );
  assert.equal(changeRequestFrom("Keep this", { summary: "" }), "Keep this");
});

test("stored verdicts normalize; malformed ones are dropped and long ones capped", () => {
  const verdict = {
    decision: "changes",
    summary: "fix",
    runId: "run-1",
    at: 5,
  };
  const load = (v) =>
    normalizeWorkspace({ agents: [], tasks: [task("t", { verdict: v })] })
      .tasks[0].verdict;
  assert.deepEqual(load(verdict), verdict);
  assert.equal(load({ ...verdict, decision: "maybe" }), undefined);
  assert.equal(load({ ...verdict, runId: 3 }), undefined);
  assert.equal(load({ ...verdict, at: Number.NaN }), undefined);
  assert.equal(load("APPROVE"), undefined);
  assert.equal(load(undefined), undefined);
  assert.equal(
    load({ ...verdict, summary: "y".repeat(VERDICT_SUMMARY_MAX + 10) }).summary
      .length,
    VERDICT_SUMMARY_MAX,
  );
});
