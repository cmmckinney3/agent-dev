import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { pureModules } from "./modules.mjs";

const temp = mkdtempSync(join(tmpdir(), "crucible-teammate-tests-"));
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
  // Names go into prompts, so nothing cmd.exe would refuse.
  for (const bad of ["R&D", 'Ada "A"', "50%", "Hi!", "a|b", "<x>", "a^b"])
    assert.match(T.teammateNameError(bad, []), /cannot use/, bad);
  assert.equal(T.teammateNameError("Zoë-2 (front end)", []), undefined);
  const [cleaned] = T.normalizeTeammates(
    [{ ...ada, name: "R&D <team>" }],
    [{ id: "claude", enabled: true }],
  );
  assert.equal(cleaned.name, "RD team");
});

test("run folders are safe slugs, one per run, so runs never share files", () => {
  const valid = /^[a-z0-9][a-z0-9-]*$/; // what desktop.rs accepts
  const run = "run-0b7e1c52-9f4d-4a8e-bd51-3f2a6c81d907";
  assert.equal(T.runFolder(ada, run), "ada-6c81d907");
  for (const name of ["Front end", "front-end", "Zoë & Co!", "---", "日本"]) {
    const folder = T.runFolder({ name }, run);
    assert.match(folder, valid, name);
    assert.ok(folder.length <= 80);
  }
  assert.notEqual(
    T.runFolder(ada, "run-aaaaaaaa"),
    T.runFolder(ada, "run-bbbbbbbb"),
    "two runs of one teammate in one folder get their own files",
  );
  assert.equal(T.runFolder({ name: "日本" }, "x"), "teammate-x");
  assert.equal(T.nameList(["Ben"]), "Ben");
  assert.equal(T.nameList(["Ben", "Cleo", "Dan"]), "Ben, Cleo and Dan");
});

test("the prompt names the teammate, brief, files and task, never the memory or a message", () => {
  const run = { folder: "ada-6c81d907", inbox: 0, team: [] };
  const prompt = T.teammatePrompt(
    { ...ada, memory: "SECRET-LINE never in argv" },
    "Fix the flaky auth test.",
    run,
  );
  const sections = prompt.split("\n\n");
  assert.equal(
    sections[0],
    "You are Ada, a teammate working through Crucible.",
  );
  assert.equal(sections[1], `Your brief:\n${ada.brief}`);
  assert.match(sections[2], /\.crucible\/ada-6c81d907\/memory\.md/);
  assert.match(sections[2], /Never store secrets/);
  assert.equal(sections.at(-1), "Task:\nFix the flaky auth test.");
  assert.equal(sections.length, 4, "no inbox and no outbox sections");
  assert.ok(!prompt.includes("SECRET-LINE"));
  const noBrief = T.teammatePrompt({ ...ada, brief: "  " }, "Do it.", run);
  assert.ok(!noBrief.includes("Your brief"));
  assert.equal(noBrief.split("\n\n").length, 3);
  // With an inbox and teammates to write to: counts, names and paths only.
  const full = T.teammatePrompt(ada, "Do it.", {
    folder: "ada-1",
    inbox: 2,
    team: ["Ben", "Cleo"],
  });
  const parts = full.split("\n\n");
  assert.equal(parts.length, 6);
  assert.match(
    parts[3],
    /^You have 2 new messages from the team in \.crucible\/ada-1\/inbox\.md\./,
  );
  assert.match(parts[4], /\(Ben and Cleo\)/);
  assert.match(
    parts[4],
    /\.crucible\/ada-1\/outbox\.md below a heading line naming who it is for, such as ## To: Ben \(## To: everyone/,
  );
  assert.match(parts[4], /do not wait for a reply/);
  // The preface adds nothing cmd.exe would refuse beyond what the task has.
  assert.doesNotMatch(full.replace("Do it.", ""), /["%!^&|<>]/);
  assert.match(
    T.teammatePrompt(ada, "x", { folder: "a", inbox: 1, team: [] }),
    /You have 1 new message from/,
  );
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
  // Messaging defaults: may write to others, holds what arrives.
  assert.equal(out[0].canMessage, true);
  assert.equal(out[0].onMessage, "hold");
  const [quiet] = T.normalizeTeammates(
    [{ ...ada, canMessage: false, onMessage: "start" }],
    agents,
  );
  assert.equal(quiet.canMessage, false);
  assert.equal(quiet.onMessage, "start");
  assert.equal(
    T.normalizeTeammates([{ ...ada, onMessage: "shout" }], agents)[0].onMessage,
    "hold",
  );
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

test("workspace: a half-written draft and templates keep their teammate across a reload", () => {
  const draft = {
    title: "t",
    prompt: "p",
    agentId: "claude",
    mode: "headless",
  };
  const w = normalizeWorkspace({
    teammates: [ada],
    projects: [
      {
        id: "p1",
        name: "One",
        cwd: "C:\\one",
        draft: { ...draft, teammateId: ada.id },
      },
      {
        id: "p2",
        name: "Two",
        cwd: "C:\\two",
        draft: { ...draft, teammateId: "teammate-gone" },
      },
    ],
    templates: [
      { id: "tp1", name: "As Ada", draft: { ...draft, teammateId: ada.id } },
      { id: "tp2", name: "Gone", draft: { ...draft, teammateId: "x" } },
    ],
  });
  assert.equal(w.projects[0].draft.teammateId, ada.id);
  assert.equal(w.projects[1].draft.teammateId, undefined);
  assert.equal(w.templates[0].draft.teammateId, ada.id);
  assert.equal(w.templates[1].draft.teammateId, undefined);
});

test("workspace: messages load, message tasks keep only known messages, strict import checks the list", () => {
  const ben = { ...ada, id: "teammate-ben", name: "Ben" };
  const w = normalizeWorkspace({
    teammates: [ada, ben],
    messages: [
      {
        id: "m1",
        from: ada.id,
        fromName: "Ada",
        to: ben.id,
        body: "hi",
        at: 5,
        hop: 2,
      },
      {
        id: "m2",
        from: ada.id,
        fromName: "Ada",
        to: "teammate-gone",
        body: "x",
        at: 6,
      },
    ],
    tasks: [
      {
        id: "t1",
        title: "Message from Ada",
        prompt: "p",
        agentId: "claude",
        mode: "headless",
        status: "backlog",
        teammateId: ben.id,
        messageIds: ["m1", "m2", 7],
        hop: 2.6,
      },
    ],
  });
  assert.deepEqual(
    w.messages.map((m) => m.id),
    ["m1"],
  );
  assert.deepEqual(w.tasks[0].messageIds, ["m1"]);
  assert.equal(w.tasks[0].hop, 3);
  assert.deepEqual(normalizeWorkspace({}).messages, []);
  assert.throws(
    () => normalizeWorkspace({ agents: [], messages: {} }, true),
    /messages/,
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
