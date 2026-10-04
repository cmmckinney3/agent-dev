import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { pureModules } from "./modules.mjs";

const temp = mkdtempSync(join(tmpdir(), "crucible-agent-tests-"));
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
const A = await import(pathToFileURL(join(temp, "agents.mjs")));
const { DEFAULT_SETTINGS, normalizeSettings } = await import(
  pathToFileURL(join(temp, "settings.mjs"))
);
after(() => {
  if (
    resolve(temp).startsWith(resolve(tmpdir()) + "\\") ||
    resolve(temp).startsWith(resolve(tmpdir()) + "/")
  )
    rmSync(temp, { recursive: true });
});

test("Claude Code is recognised by its program, whatever the agent is called", () => {
  for (const program of [
    "claude",
    "Claude.exe",
    " claude.cmd ",
    "C:\\Users\\me\\.local\\bin\\claude.exe",
    "/usr/local/bin/claude",
  ])
    assert.equal(A.isClaudeCode({ program }), true, program);
  for (const program of [
    "codex",
    "claude-code-router",
    "myclaude",
    "claude.sh",
    "",
  ])
    assert.equal(A.isClaudeCode({ program }), false, program);
  assert.equal(
    A.DEFAULT_AGENTS.filter(A.isClaudeCode)
      .map((a) => a.id)
      .join(),
    "claude",
  );
});

test("hook settings go first, unless the agent already passes its own", () => {
  assert.deepEqual(
    A.withHookSettings(["Fix it"], "C:\\data\\claude-hooks.json"),
    ["--settings", "C:\\data\\claude-hooks.json", "Fix it"],
  );
  assert.deepEqual(A.withHookSettings(["--resume", "abc"], "h.json"), [
    "--settings",
    "h.json",
    "--resume",
    "abc",
  ]);
  for (const own of [
    ["--settings", "mine.json", "Fix it"],
    ["--settings=mine.json"],
  ])
    assert.deepEqual(A.withHookSettings(own, "h.json"), own);
});

test("the hooks setting is on by default and survives a reload", () => {
  assert.equal(DEFAULT_SETTINGS.claudeHooks, true);
  assert.equal(normalizeSettings({}).claudeHooks, true);
  assert.equal(normalizeSettings({ claudeHooks: false }).claudeHooks, false);
  assert.equal(normalizeSettings({ claudeHooks: "no" }).claudeHooks, true);
});
