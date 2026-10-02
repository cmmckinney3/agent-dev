import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const temp = mkdtempSync(join(tmpdir(), "crucible-teammate-tests-"));
for (const name of [
  "workspace",
  "layout",
  "agents",
  "settings",
  "tasks",
  "usage",
  "teammates",
]) {
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
const T = await import(pathToFileURL(join(temp, "teammates.mjs")));
const { normalizeWorkspace } = await import(
  pathToFileURL(join(temp, "workspace.mjs"))
);
const { normalizeRuns } = await import(pathToFileURL(join(temp, "usage.mjs")));
const { draftFromTask } = await import(pathToFileURL(join(temp, "tasks.mjs")));
after(() => {
  if (
    resolve(temp).startsWith(resolve(tmpdir()) + "\\") ||
    resolve(temp).startsWith(resolve(tmpdir()) + "/")
  )
    rmSync(temp, { recursive: true });
});

const ada = {
  id: "teammate-7f02d841",
  name: "Ada",
  agentId: "claude",
  brief: "Owns the auth module. Run the tests before saying done.",
  memory: "- prefers pnpm",
  createdAt: 1,
};

test("names: required, capped, unique regardless of case", () => {
  assert.match(T.teammateNameError("  ", []), /name/);
  assert.match(T.teammateNameError("x".repeat(T.NAME_MAX + 1), []), /40/);
  assert.match(T.teammateNameError("ada", [ada]), /already/);
  assert.equal(T.teammateNameError("Ada", [ada], ada.id), undefined);
  assert.equal(T.teammateNameError("Grace", [ada]), undefined);
});

test("memory file names are safe slugs that never collide", () => {
  const valid = /^[a-z0-9][a-z0-9-]*\.md$/; // what desktop.rs accepts
  assert.equal(T.memoryFileName(ada), "ada-02d841.md");
  for (const name of ["Front end", "front-end", "Zoë & Co!", "---", "日本"]) {
    const file = T.memoryFileName({ id: "teammate-abc123", name });
    assert.match(file, valid, name);
    assert.ok(file.length <= 80);
  }
  assert.notEqual(
    T.memoryFileName({ id: "teammate-aaaaaa", name: "Front end" }),
    T.memoryFileName({ id: "teammate-bbbbbb", name: "front-end" }),
  );
  assert.equal(T.memoryFileName({ id: "x", name: "日本" }), "teammate-x.md");
  assert.equal(T.memoryPath(ada), ".crucible/memory/ada-02d841.md");
});

test("the prompt names the teammate, brief, memory path and task, never the memory", () => {
  const prompt = T.teammatePrompt(
    { ...ada, memory: "SECRET-LINE never in argv" },
    "Fix the flaky auth test.",
  );
  const sections = prompt.split("\n\n");
  assert.equal(
    sections[0],
    "You are Ada, a teammate working through Crucible.",
  );
  assert.equal(sections[1], `Your brief:\n${ada.brief}`);
  assert.match(sections[2], /\.crucible\/memory\/ada-02d841\.md/);
  assert.match(sections[2], /Never store secrets/);
  assert.equal(sections.at(-1), "Task:\nFix the flaky auth test.");
  assert.ok(!prompt.includes("SECRET-LINE"));
  const noBrief = T.teammatePrompt({ ...ada, brief: "  " }, "Do it.");
  assert.ok(!noBrief.includes("Your brief"));
  assert.equal(noBrief.split("\n\n").length, 3);
});

test("merge: nothing back, or nothing new, changes nothing", () => {
  const seeded = "- a\n- b";
  for (const returned of [null, undefined, "- a\n- b", "- a\r\n- b\r\n"]) {
    assert.deepEqual(T.mergeMemory(seeded, seeded, returned), {
      memory: seeded,
      changed: false,
      trimmed: false,
    });
  }
});

test("merge: an untouched store takes the file as is, pruning included", () => {
  const result = T.mergeMemory(
    "- a\n- wrong",
    "- a\n- wrong",
    "- a\n- right\n",
  );
  assert.deepEqual(result, {
    memory: "- a\n- right",
    changed: true,
    trimmed: false,
  });
  // From an empty memory the teammate's first notes become the memory.
  assert.equal(T.mergeMemory("", "", "- first\n").memory, "- first");
});

test("merge: a store edited during the run keeps its edits and gains only new lines", () => {
  const seeded = "- a\n- b";
  const current = "- a\n- b\n- owner added this"; // edited on the Teammates page
  const returned = "- a\n- b (rewritten)\n- c\n- c\n- owner added this\n\n";
  const result = T.mergeMemory(seeded, current, returned);
  assert.equal(
    result.memory,
    "- a\n- b\n- owner added this\n- b (rewritten)\n- c",
  );
  assert.equal(result.changed, true);
  // Deleting a line in the file cannot delete it from an edited store.
  const pruned = T.mergeMemory(seeded, current, "- a\n");
  assert.equal(pruned.changed, false);
  assert.equal(pruned.memory, current);
});

test("merge: control characters are stripped and the oldest lines give way to the cap", () => {
  assert.equal(T.mergeMemory("", "", "- ok\u0007\u0000\n").memory, "- ok");
  const old = Array.from({ length: 1200 }, (_, i) => `- old note ${i}`).join(
    "\n",
  );
  const result = T.mergeMemory(old, old, `${old}\n- newest`);
  assert.equal(result.trimmed, true);
  assert.ok(result.memory.length <= T.MEMORY_MAX);
  assert.ok(result.memory.endsWith("- newest"));
  assert.ok(!result.memory.startsWith("- old note 0\n"));
  assert.ok(
    result.memory.split("\n").every((l) => l.startsWith("- ")),
    "whole lines only",
  );
});

test("normalize: bad records dropped, engines resolved, names kept unique, text capped", () => {
  const agents = [
    { id: "claude", enabled: true },
    { id: "codex", enabled: true },
  ];
  assert.deepEqual(T.normalizeTeammates("nope", agents), []);
  const out = T.normalizeTeammates(
    [
      ada,
      { ...ada }, // duplicate id
      { id: "t2", name: "ADA", agentId: "gone", brief: 4, memory: "m\r\nn" },
      { id: "t3", name: "  " },
      { name: "no id" },
      null,
      {
        id: "t4",
        name: "Grace",
        agentId: "codex",
        brief: "b".repeat(9000),
        memory: "z".repeat(40000),
      },
    ],
    agents,
  );
  assert.deepEqual(
    out.map((t) => t.name),
    ["Ada", "ADA 2", "Grace"],
  );
  assert.equal(out[1].agentId, "claude", "a missing engine falls back");
  assert.equal(out[1].brief, "");
  assert.equal(out[1].memory, "m\nn");
  assert.equal(out[2].agentId, "codex");
  assert.equal(out[2].brief.length, T.BRIEF_MAX);
  assert.equal(out[2].memory.length, T.MEMORY_MAX);
  assert.equal(typeof out[1].createdAt, "number");
});

test("workspace: teammates load, task links to missing teammates drop, strict import checks the list", () => {
  const w = normalizeWorkspace({
    teammates: [ada],
    tasks: [
      {
        id: "t1",
        title: "a",
        prompt: "p",
        agentId: "claude",
        mode: "headless",
        status: "backlog",
        teammateId: ada.id,
      },
      {
        id: "t2",
        title: "b",
        prompt: "p",
        agentId: "claude",
        mode: "headless",
        status: "backlog",
        teammateId: "teammate-gone",
      },
    ],
  });
  assert.equal(w.teammates.length, 1);
  assert.equal(w.tasks[0].teammateId, ada.id);
  assert.equal(w.tasks[1].teammateId, undefined);
  assert.deepEqual(normalizeWorkspace({}).teammates, []);
  assert.throws(
    () => normalizeWorkspace({ agents: [], teammates: {} }, true),
    /teammates/,
  );
  assert.equal(
    draftFromTask(w.tasks[0]).teammateId,
    ada.id,
    "the composer owns the choice",
  );
});

test("run records keep the teammate that did the run", () => {
  const [run] = normalizeRuns([
    {
      id: "run-1",
      agentId: "claude",
      startedAt: 1,
      outcome: "completed",
      teammateId: ada.id,
      teammateName: "Ada",
    },
  ]);
  assert.equal(run.teammateId, ada.id);
  assert.equal(run.teammateName, "Ada");
  assert.equal(
    normalizeRuns([
      { id: "run-2", agentId: "claude", startedAt: 1, teammateName: 3 },
    ])[0].teammateName,
    undefined,
  );
});
