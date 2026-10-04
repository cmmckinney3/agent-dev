import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { pureModules } from "./modules.mjs";

const temp = mkdtempSync(join(tmpdir(), "crucible-message-tests-"));
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
const M = await import(pathToFileURL(join(temp, "messages.mjs")));
after(() => {
  if (
    resolve(temp).startsWith(resolve(tmpdir()) + "\\") ||
    resolve(temp).startsWith(resolve(tmpdir()) + "/")
  )
    rmSync(temp, { recursive: true });
});

const ada = { id: "t-ada", name: "Ada", agentId: "claude" };
const ben = { id: "t-ben", name: "Ben", agentId: "codex" };
const cleo = { id: "t-cleo", name: "Cleo Park", agentId: "claude" };
const team = [ada, ben, cleo];
const read = (text, sent) => M.readOutbox(text, ada, team, sent);
const message = (id, patch = {}) => ({
  id,
  from: ada.id,
  fromName: "Ada",
  to: ben.id,
  body: `body of ${id}`,
  at: 1,
  hop: 1,
  ...patch,
});

test("outbox: each `## To:` heading starts a message; text before the first is the teammate's own", () => {
  const { drafts, problems } = read(
    [
      "Notes to self, not a message.",
      "## To: Ben",
      "",
      "Tauri 2.12 needs the notification plugin registered before setup.",
      "Check lib.rs.",
      "",
      "## To: Cleo Park",
      "Ask me about the auth flow.",
    ].join("\r\n"),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(drafts, [
    {
      to: ben.id,
      body: "Tauri 2.12 needs the notification plugin registered before setup.\nCheck lib.rs.",
    },
    { to: cleo.id, body: "Ask me about the auth flow." },
  ]);
});

test("outbox: recipients are matched loosely but never guessed", () => {
  const to = (header) => read(`${header}\nhello`).drafts.map((d) => d.to);
  assert.deepEqual(to("## To: ben"), [ben.id]);
  assert.deepEqual(to("**To:** @Ben"), [ben.id]);
  assert.deepEqual(to("**To: Ben**"), [ben.id]);
  assert.deepEqual(to("### to:  Ben, Cleo Park"), [ben.id, cleo.id]);
  assert.deepEqual(to("## To: Ben and Cleo Park"), [ben.id, cleo.id]);
  assert.deepEqual(to("## To: Ben (re: auth)"), [ben.id]);
  assert.deepEqual(to("## To: everyone"), [ben.id, cleo.id], "not itself");
  assert.deepEqual(to("To: Ben"), [ben.id], "a bare line naming a teammate");
  // Writing to itself is dropped quietly; an unknown name is reported.
  assert.deepEqual(read("## To: Ada\nnote").drafts, []);
  const unknown = read("## To: Bob, Ben\nhi");
  assert.deepEqual(unknown.drafts, [{ to: ben.id, body: "hi" }]);
  assert.deepEqual(unknown.problems, ["No teammate is called “Bob”."]);
});

test("outbox: a bare `To:` that names no teammate is prose, not a header", () => {
  const { drafts, problems } = read(
    "## To: Ben\nPlan:\nTo: be fair, the test is flaky.\nTo do: fix it.",
  );
  assert.deepEqual(problems, []);
  assert.equal(drafts.length, 1);
  assert.equal(
    drafts[0].body,
    "Plan:\nTo: be fair, the test is flaky.\nTo do: fix it.",
  );
});

test("outbox: bodies are tidied and capped; empty and repeated messages are dropped", () => {
  const long = "x".repeat(M.BODY_MAX + 50);
  const { drafts } = read(
    `## To: Ben\n\n  \n${long}\n\n## To: Cleo Park\n\n## To: Ben\nsame\u0007\n## To: Ben\nsame\n`,
  );
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].body.length, M.BODY_MAX);
  assert.ok(drafts[0].body.endsWith("…"));
  assert.equal(
    drafts[1].body,
    "same",
    "control characters stripped, duplicate dropped",
  );
});

test("outbox: read again later, only new messages go, up to SEND_MAX a run", () => {
  const first = read("## To: Ben\none");
  const sent = new Set(first.drafts.map(M.draftKey));
  const second = read("## To: Ben\none\n\n## To: Ben\ntwo", sent);
  assert.deepEqual(second.drafts, [{ to: ben.id, body: "two" }]);
  // The teammate may clear the file between turns: nothing is lost or resent.
  assert.deepEqual(read("", sent).drafts, []);
  const many = Array.from(
    { length: M.SEND_MAX + 3 },
    (_, i) => `## To: Ben\nmessage ${i}`,
  ).join("\n");
  const capped = read(many, sent);
  assert.equal(capped.drafts.length, M.SEND_MAX - 1);
  assert.deepEqual(capped.problems, [
    `4 more messages were not sent: one run sends at most ${M.SEND_MAX}.`,
  ]);
  // "everyone" counts once per recipient.
  assert.equal(
    read(
      Array.from({ length: 6 }, (_, i) => `## To: everyone\nm${i}`).join("\n"),
    ).drafts.length,
    M.SEND_MAX,
  );
});

test("inbox: who, when, where, oldest first, with the recipient's last message to a teammate quoted", () => {
  const projects = [{ id: "p1", name: "web-app" }];
  const asked = message("m0", {
    from: ben.id,
    fromName: "Ben",
    to: ada.id,
    body: "Which test runner?\nWe use two.",
    at: Date.UTC(2026, 9, 3, 9, 0),
  });
  const reply = message("m1", {
    from: ada.id,
    to: ben.id,
    body: "Use vitest.",
    at: Date.UTC(2026, 9, 3, 10, 5),
    projectId: "p1",
  });
  const owner = message("m2", {
    from: M.OWNER,
    fromName: "You",
    to: ben.id,
    body: "Ship it today.",
    at: Date.UTC(2026, 9, 3, 11, 0),
  });
  const text = M.inboxText(
    ben,
    [owner, reply],
    [asked, reply, owner],
    team,
    projects,
  );
  assert.equal(
    text,
    [
      "# Messages for Ben",
      "2 new messages, oldest first. Messages from the owner come from the person you work for.",
      "## From Ada, 2026-10-03 10:05 UTC, project “web-app”",
      "Use vitest.",
      "> Your last message to Ada, for context:\n> Which test runner?\n> We use two.",
      "## From the owner, 2026-10-03 11:00 UTC",
      "Ship it today.",
    ].join("\n\n") + "\n",
  );
  // A renamed sender shows its current name; a deleted one its old name.
  assert.match(
    M.inboxText(ben, [reply], [reply], [{ ...ada, name: "Ada L" }, ben], []),
    /## From Ada L,/,
  );
  assert.match(M.inboxText(ben, [reply], [reply], [ben], []), /## From Ada,/);
  // Long context is cut.
  const quoted = M.inboxText(
    ada,
    [message("m3", { from: ben.id, to: ada.id, at: 9 })],
    [
      message("m4", {
        from: ada.id,
        to: ben.id,
        at: 8,
        body: "q".repeat(2000),
      }),
    ],
    team,
    [],
  );
  assert.ok(quoted.includes(`> ${"q".repeat(M.QUOTE_MAX - 1)}…`));
});

test("delivery: waiting messages to the recipient, oldest first, capped, a task's own always included", () => {
  const all = [
    ...Array.from({ length: M.INBOX_MAX + 5 }, (_, i) =>
      message(`w${i}`, { at: 100 + i }),
    ),
    message("done", { at: 1, deliveredAt: 2 }),
    message("other", { to: cleo.id, at: 3 }),
  ];
  const plain = M.messagesToDeliver(all, ben.id);
  assert.equal(plain.length, M.INBOX_MAX);
  assert.equal(plain[0].id, "w0");
  assert.ok(!plain.some((m) => m.id === "done" || m.id === "other"));
  const forTask = M.messagesToDeliver(all, ben.id, [
    "done",
    `w${M.INBOX_MAX + 4}`,
  ]);
  assert.equal(forTask.length, M.INBOX_MAX);
  assert.equal(forTask[0].id, "done", "re-delivered, in time order");
  assert.ok(forTask.some((m) => m.id === `w${M.INBOX_MAX + 4}`));
  assert.equal(M.waitingFor(all, ben.id), M.INBOX_MAX + 5);
});

test("arrival: hold by default; start only when allowed and within the chain", () => {
  const on = { messageStarts: true, messageChainLimit: 3 };
  assert.equal(M.arrival({ onMessage: "hold" }, 1, on), "hold");
  assert.equal(M.arrival({ onMessage: "start" }, 1, on), "start");
  assert.equal(M.arrival({ onMessage: "start" }, 3, on), "start");
  assert.equal(M.arrival({ onMessage: "start" }, 4, on), "chain");
  assert.equal(
    M.arrival({ onMessage: "start" }, 1, { ...on, messageStarts: false }),
    "paused",
  );
  // An owner-started run sends hop 1; a message-started run one deeper.
  assert.equal(M.nextHop(undefined), 1);
  assert.equal(M.nextHop({}), 1);
  assert.equal(M.nextHop({ hop: 2 }), 3);
});

test("message tasks: headless in the sender's folder, as deep as their deepest message", () => {
  const task = M.messageTaskFor(
    ben,
    [
      message("m1", { hop: 2 }),
      message("m2", { from: M.OWNER, fromName: "You" }),
    ],
    team,
    { projectId: "p1", cwd: "C:\\wt\\lane" },
    { id: "task-1", now: 7 },
  );
  assert.deepEqual(task, {
    id: "task-1",
    title: "Messages from Ada and you",
    prompt: M.MESSAGE_TASK_PROMPT,
    agentId: "codex",
    teammateId: ben.id,
    cwd: "C:\\wt\\lane",
    mode: "headless",
    status: "backlog",
    projectId: "p1",
    priority: "normal",
    createdAt: 7,
    isolation: false,
    dependencies: [],
    messageIds: ["m1", "m2"],
    hop: 2,
  });
  // Fixed text only: safe as an argument, even through cmd.exe.
  assert.doesNotMatch(M.MESSAGE_TASK_PROMPT, /["%!^&|<>\r\n]/);
  assert.equal(M.messageTaskTitle(["Ada"], 1), "Message from Ada");
  assert.equal(M.messageTaskTitle(["Ada", "Ada"], 2), "Messages from Ada");
  assert.equal(
    M.messageTaskTitle(["A", "B", "C", "D"], 4),
    "Messages from A, B and 2 others",
  );
});

test("a new message joins the recipient's unstarted message task in the same folder", () => {
  const where = { projectId: "p1", cwd: "C:\\one" };
  const base = {
    id: "t1",
    teammateId: ben.id,
    messageIds: ["m1"],
    status: "backlog",
    projectId: "p1",
    cwd: "C:\\one",
  };
  assert.equal(M.pendingMessageTask([base], ben.id, where)?.id, "t1");
  for (const patch of [
    { paneId: "pane-1" },
    { status: "running" },
    { archived: true },
    { cwd: "C:\\two" },
    { projectId: "p2" },
    { messageIds: undefined },
    { teammateId: cleo.id },
  ])
    assert.equal(
      M.pendingMessageTask([{ ...base, ...patch }], ben.id, where),
      undefined,
      JSON.stringify(patch),
    );
});

test("a message task waits while its teammate is at work in the same folder", () => {
  const projects = [
    { id: "p1", cwd: "C:\\one" },
    { id: "p2", cwd: "C:\\two" },
  ];
  const waiting = {
    id: "w2",
    teammateId: ben.id,
    messageIds: ["m2"],
    projectId: "p1",
    status: "backlog",
  };
  const busy = {
    id: "w1",
    teammateId: ben.id,
    projectId: "p1",
    paneId: "pane-1",
  };
  assert.equal(M.messageTaskWaits(waiting, [waiting, busy], projects), true);
  // Free once that run ends, or when the busy run is elsewhere or someone else.
  for (const other of [
    { ...busy, paneId: undefined },
    { ...busy, projectId: "p2" },
    { ...busy, worktree: "C:\\wt\\lane" },
    { ...busy, teammateId: cleo.id },
  ])
    assert.equal(
      M.messageTaskWaits(waiting, [waiting, other], projects),
      false,
      JSON.stringify(other),
    );
  // The owner's own tasks for the teammate are never held back.
  const owners = { ...waiting, messageIds: undefined };
  assert.equal(M.messageTaskWaits(owners, [owners, busy], projects), false);
});

test("normalize: malformed messages and messages to deleted teammates are dropped", () => {
  const ids = new Set([ada.id, ben.id]);
  assert.deepEqual(M.normalizeMessages("nope", ids), []);
  const out = M.normalizeMessages(
    [
      message("m1", { at: 5, hop: 2.4, deliveredRunId: "run-x" }),
      message("m1"), // duplicate id
      message("m2", { to: "t-gone" }),
      message("m3", { from: ben.id }), // to itself
      message("m4", { body: "  " }),
      message("m5", { at: "soon" }),
      message("m6", { from: "t-deleted", fromName: "Old", at: 2 }),
      message("m7", {
        from: M.OWNER,
        fromName: "Me",
        body: "x".repeat(9000),
        at: 3,
        hop: -4,
      }),
      message("m8", {
        at: 4,
        deliveredAt: 9,
        deliveredRunId: "run-y",
        taskId: "t",
      }),
      null,
    ],
    ids,
  );
  assert.deepEqual(
    out.map((m) => m.id),
    ["m6", "m7", "m8", "m1"],
    "oldest first",
  );
  const [old, owner, delivered, first] = out;
  assert.equal(old.fromName, "Old", "a deleted sender keeps its name");
  assert.equal(owner.fromName, "You");
  assert.equal(owner.body.length, M.BODY_MAX);
  assert.equal(owner.hop, 1);
  assert.equal(first.hop, 2);
  assert.equal(
    first.deliveredRunId,
    undefined,
    "only a delivered message has one",
  );
  assert.equal(delivered.deliveredRunId, "run-y");
  assert.equal(delivered.taskId, "t");
});

test("retention keeps every waiting message before any delivered one", () => {
  const many = Array.from({ length: M.MESSAGES_KEPT + 3 }, (_, i) =>
    message(`m${i}`, { at: i, deliveredAt: i < 10 ? undefined : i }),
  );
  const kept = M.retainMessages(many);
  assert.equal(kept.length, M.MESSAGES_KEPT);
  assert.ok(
    kept.some((m) => m.id === "m0"),
    "the oldest waiting message stays",
  );
  assert.ok(!kept.some((m) => m.id === "m10"), "the oldest delivered one goes");
  assert.equal(M.retainMessages(many.slice(0, 3)).length, 3);
});
