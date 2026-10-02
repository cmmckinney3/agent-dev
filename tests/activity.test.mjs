import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const temp = mkdtempSync(join(tmpdir(), "crucible-activity-tests-"));
const source = readFileSync(
  new URL("../src/activity.ts", import.meta.url),
  "utf8",
);
writeFileSync(
  join(temp, "activity.mjs"),
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText,
);
const A = await import(pathToFileURL(join(temp, "activity.mjs")));
after(() => {
  if (
    resolve(temp).startsWith(resolve(tmpdir()) + "\\") ||
    resolve(temp).startsWith(resolve(tmpdir()) + "/")
  )
    rmSync(temp, { recursive: true });
});

const noScreen = () => [];
/** Stream output chunks every `step` ms from `from` to `to` (inclusive). */
const stream = (s, from, to, step = 100) => {
  for (let t = from; t <= to; t += step) s = A.onOutput(s, t);
  return s;
};

test("a seeded launch works, then finishes as Done once output settles", () => {
  let s = A.initialActivity(0, true);
  assert.equal(s.activity, "working");
  s = stream(s, 1000, 3000);
  s = A.onTick(s, 4000, noScreen);
  assert.equal(s.activity, "working", "quiet for 1s is still working");
  s = A.onTick(s, 5000, noScreen);
  assert.equal(s.activity, "done");
  assert.equal(s.since, 3000, "done since the last output");
  assert.equal(s.turn, false);
});

test("a CLI that takes a while to start is not mistaken for finished", () => {
  let s = A.initialActivity(0, true);
  s = A.onTick(s, 5000, noScreen);
  assert.equal(s.activity, "working");
  s = A.onTick(s, A.STARTUP_MS + 1, noScreen);
  assert.equal(s.activity, "done");
});

test("an unseeded session's startup burst settles as Idle, not Done", () => {
  let s = A.initialActivity(0, false);
  assert.equal(s.activity, "idle");
  s = stream(s, 100, 800, 50);
  assert.equal(s.activity, "working");
  s = A.onTick(s, 3000, noScreen);
  assert.equal(s.activity, "idle");
});

test("echoed typing and resize redraws never start work", () => {
  let s = A.initialActivity(0, false);
  s = stream(s, 0, 500, 50);
  s = A.onTick(s, 3000, noScreen);
  assert.equal(s.activity, "idle");
  for (let t = 10000; t < 12000; t += 150) {
    s = A.onInput(s, t, "x");
    s = A.onOutput(s, t + 20);
  }
  assert.equal(s.activity, "idle", "typing echo");
  s = A.onResize(s, 20000);
  s = stream(s, 20010, 20390, 30);
  assert.equal(s.activity, "idle", "resize redraw");
});

test("a single stray redraw or a slow periodic one is not work", () => {
  let s = A.initialActivity(0, false);
  s = stream(s, 0, 600, 50);
  s = A.onTick(s, 5000, noScreen);
  assert.equal(s.activity, "idle");
  for (let t = 10000; t < 20000; t += 1000) s = A.onOutput(s, t);
  assert.equal(s.activity, "idle");
});

test("submitting with Enter starts a turn that ends as Done", () => {
  let s = A.onTick(
    stream(A.initialActivity(0, false), 0, 600, 50),
    5000,
    noScreen,
  );
  s = A.onInput(s, 10000, "fix the tests\r");
  assert.equal(s.turn, true);
  s = A.onOutput(s, 10100);
  assert.equal(s.activity, "idle", "the Enter echo is discounted");
  s = A.onOutput(s, 10500);
  assert.equal(s.activity, "working", "first output past the echo window");
  s = stream(s, 10600, 20000);
  s = A.onTick(s, 23000, noScreen);
  assert.equal(s.activity, "done");
});

test("an approval prompt on screen makes the agent wait, with the question as reason", () => {
  let s = stream(A.initialActivity(0, true), 100, 2000);
  const screen = [
    "╭──────────────────────────────╮",
    "│ Bash command                 │",
    "│   npm test                   │",
    "│ Do you want to proceed?      │",
    "│ ❯ 1. Yes                     │",
    "│   2. No, and tell Claude     │",
    "╰──────────────────────────────╯",
  ];
  s = A.onTick(s, 5000, () => screen);
  assert.equal(s.activity, "waiting");
  assert.equal(s.reason, "Do you want to proceed?");
  assert.equal(s.turn, true, "the turn continues after the answer");
  s = A.onInput(s, 6000, "1");
  assert.equal(s.activity, "idle", "answered");
  s = A.onOutput(s, 6500);
  assert.equal(s.activity, "working");
});

test("waiting patterns: what matches and what must not", () => {
  const match = [
    [
      "Do you want to make this edit to App.tsx?",
      "Do you want to make this edit to App.tsx?",
    ],
    [
      "Would you like to run the following command?",
      "Would you like to run the following command?",
    ],
    ["Allow command?", "Allow command?"],
    [
      "Do you trust the files in this folder?",
      "Do you trust the files in this folder?",
    ],
    ["Overwrite config.json? (y/n)", "Overwrite config.json? (y/n)"],
    ["Continue [Y/n]", "Continue [Y/n]"],
    ["Press Enter to continue", "Press Enter to continue"],
    // Exact wording found in the installed CLIs (Claude Code 2.1, Codex 0.159).
    [
      "Is this a project you created or one you trust?",
      "Is this a project you created or one you trust?",
    ],
    ["Trust this directory?", "Trust this directory?"],
    [
      "Do you want to allow Claude to fetch this content?",
      "Do you want to allow Claude to fetch this content?",
    ],
    [
      "Would you like to make the following edits?",
      "Would you like to make the following edits?",
    ],
    [
      "Would you like to grant these permissions?",
      "Would you like to grant these permissions?",
    ],
  ];
  for (const [line, reason] of match)
    assert.equal(A.waitingReason(["some output", line]), reason, line);
  assert.equal(
    A.waitingReason(["Pick a model?", "› 1. gpt-6", "  2. gpt-6-mini"]),
    "Pick a model?",
    "a menu borrows the question above it",
  );
  assert.equal(
    A.waitingReason(["❯ 1. Yes", "  2. No"]),
    "Waiting for you to choose an option",
  );
  const quiet = [
    "Allowed origins updated.",
    "Approved by the reviewer.",
    "› write the e2e for the cancelled-tier path",
    '> Try "git diff", or type help',
    "Worked for 1m 08s",
    "1. Read the file",
    "? for shortcuts",
  ];
  for (const line of quiet)
    assert.equal(A.waitingReason([line]), undefined, line);
});

test("only the last screen lines are checked", () => {
  const lines = [
    "Overwrite? (y/n)",
    ...Array.from({ length: 12 }, (_, i) => `line ${i}`),
  ];
  assert.equal(A.waitingReason(lines), undefined);
  assert.equal(
    A.waitingReason(["", "  ", "Overwrite? (y/n)", ""]),
    "Overwrite? (y/n)",
  );
});

test("a prompt printed in one chunk is still noticed", () => {
  let s = A.onTick(
    stream(A.initialActivity(0, false), 0, 600, 50),
    5000,
    noScreen,
  );
  s = A.onOutput(s, 10000);
  assert.equal(s.activity, "idle");
  assert.equal(s.unchecked, true);
  let reads = 0;
  const screen = () => (reads++, ["Delete 3 files? (y/n)"]);
  s = A.onTick(s, 11000, screen);
  assert.equal(reads, 0, "not read before the output settles");
  s = A.onTick(s, 12500, screen);
  assert.equal(s.activity, "waiting");
  assert.equal(s.unchecked, false);
  s = A.onTick(s, 14000, screen);
  assert.equal(reads, 1, "read once");
});

test("OSC 9 and bells ask for attention; a bell right after typing does not", () => {
  let s = A.initialActivity(0, false);
  s = A.onAttention(s, 100, "Claude needs your permission\x07");
  assert.equal(s.activity, "waiting");
  assert.equal(s.reason, "Claude needs your permission");
  const since = s.since;
  s = A.onAttention(s, 900, "again");
  assert.equal(s.since, since, "still waiting since the first request");
  s = A.onInput(s, 1000, "\r");
  s = A.onBell(s, 1100);
  assert.equal(s.activity, "idle", "tab-completion bell");
  s = A.onBell(s, 5000);
  assert.equal(s.activity, "waiting");
  assert.equal(s.reason, "Terminal bell");
});

test("focus and mouse reports are not the user answering", () => {
  let s = A.onAttention(A.initialActivity(0, false), 0, "Approve?");
  s = A.onInput(s, 100, "\x1b[I");
  s = A.onInput(s, 200, "\x1b[<0;10;5M\x1b[<0;10;5m");
  assert.equal(s.activity, "waiting");
  assert.equal(s.lastNudgeAt, 200, "still discounts the redraw it causes");
});

test("seen and exit", () => {
  let s = A.onTick(
    stream(A.initialActivity(0, true), 100, 1000),
    4000,
    noScreen,
  );
  assert.equal(s.activity, "done");
  s = A.onSeen(s, 5000);
  assert.equal(s.activity, "idle");
  assert.equal(A.onSeen(s, 6000), s, "seen is a no-op when nothing is new");
  s = A.onExit(s, 7000, "Exited with code 1");
  assert.equal(s.activity, "done");
  assert.equal(s.reason, "Exited with code 1");
  s = A.onExit(A.initialActivity(0, true), 7000, "Stopped", true);
  assert.equal(s.activity, "idle");
});

test("unchanged states keep their identity so listeners hear only transitions", () => {
  const s = A.onTick(
    stream(A.initialActivity(0, true), 100, 1000),
    4000,
    noScreen,
  );
  assert.equal(A.onTick(s, 9000, noScreen), s);
  const w = A.onAttention(s, 9000, "Approve?");
  assert.equal(A.activityChanged(s, w), true);
  assert.equal(A.activityChanged(w, A.onAttention(w, 9500, "Approve?")), false);
});

test("reasons are cleaned and capped; elapsed time is short", () => {
  assert.equal(A.cleanReason("  a\x1b[31m\tb \u0085 c "), "a [31m b c");
  const long = A.cleanReason("x".repeat(500));
  assert.equal(long.length, A.REASON_MAX);
  assert.ok(long.endsWith("…"));
  assert.equal(A.formatElapsed(3000), "now");
  assert.equal(A.formatElapsed(45000), "45s");
  assert.equal(A.formatElapsed(9 * 60000), "9m");
  assert.equal(A.formatElapsed(2 * 3600000), "2h");
  assert.equal(A.formatElapsed(3 * 86400000), "3d");
});
