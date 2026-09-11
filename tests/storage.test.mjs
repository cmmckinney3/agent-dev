import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// storage.ts is the only funnel for persistence, so its failure reporting is
// what keeps "Changes could not be saved" from being a silent no-op.
const temp = mkdtempSync(join(tmpdir(), "crucible-storage-tests-"));
const bridge = { calls: [], invoke: async () => {} };
writeFileSync(
  join(temp, "native.mjs"),
  `
export const bridge = globalThis.__crucibleBridge;
export const isTauri = () => true;
export const invoke = async (name, args) => { bridge.calls.push({ name, args }); return bridge.invoke(name, args); };
`,
);
for (const name of [
  "storage",
  "workspace",
  "layout",
  "agents",
  "settings",
  "tasks",
  "usage",
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
  // Relative imports first: rewriting the native one before this would turn
  // "./native.mjs" into "./native.mjs.mjs".
  writeFileSync(
    join(temp, `${name}.mjs`),
    outputText
      .replace(/from "\.\/([^"]+)"/g, 'from "./$1.mjs"')
      .replace(/from "@tauri-apps\/api\/core"/g, 'from "./native.mjs"'),
  );
}
globalThis.__crucibleBridge = bridge;
// Node leaves localStorage undefined; the success path clears the legacy keys.
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
const {
  loadWorkspace,
  scheduleSave,
  flushSave,
  onStorageError,
  onStorageSaving,
} = await import(pathToFileURL(join(temp, "storage.mjs")));
const { normalizeWorkspace } = await import(
  pathToFileURL(join(temp, "workspace.mjs"))
);
after(() => {
  if (
    resolve(temp).startsWith(resolve(tmpdir()) + "\\") ||
    resolve(temp).startsWith(resolve(tmpdir()) + "/")
  )
    rmSync(temp, { recursive: true });
});

test("a failed save is reported, keeps its snapshot, and clears on a successful retry", async () => {
  const errors = [];
  onStorageError((e) => errors.push(e));
  onStorageSaving(() => {});
  const workspace = normalizeWorkspace({});
  workspace.boardWidth = 321;

  bridge.calls.length = 0;
  bridge.invoke = async () => {
    throw new Error("disk full");
  };
  scheduleSave(workspace);
  await assert.rejects(flushSave(), /disk full/);
  assert.match(String(errors.at(-1)), /disk full/);

  // The rejected snapshot must survive so the next attempt still saves it.
  bridge.invoke = async () => {};
  await flushSave();
  const saved = bridge.calls.filter((c) => c.name === "save_workspace");
  assert.equal(saved.length, 2, "the retry replays the save");
  assert.equal(saved.at(-1).args.workspace.boardWidth, 321);
  assert.equal(errors.at(-1), undefined, "a successful save clears the banner");
});

test("one failure does not poison later saves", async () => {
  const errors = [];
  onStorageError((e) => errors.push(e));
  const workspace = normalizeWorkspace({});
  bridge.calls.length = 0;
  bridge.invoke = async () => {
    throw new Error("locked");
  };
  scheduleSave(workspace);
  await assert.rejects(flushSave(), /locked/);

  bridge.invoke = async () => {};
  workspace.boardWidth = 400;
  scheduleSave(workspace);
  await flushSave();
  assert.equal(errors.at(-1), undefined);
  assert.equal(bridge.calls.at(-1).args.workspace.boardWidth, 400);
});

test("a locked credential vault loads the workspace and reports only the credentials", async () => {
  const store = normalizeWorkspace({});
  bridge.invoke = async () => ({
    workspace: store,
    credentials:
      "Saved credentials could not be unlocked, so they were cleared: sealed by another profile",
  });
  const loaded = await loadWorkspace();
  // The projects must survive: a re-enterable key is not workspace loss.
  assert.ok(loaded.workspace.projects.length);
  assert.match(loaded.warning, /credentials could not be unlocked/);

  bridge.invoke = async () => ({ workspace: store, recovered: true });
  assert.match(
    (await loadWorkspace()).warning,
    /Recovered the last known good workspace/,
  );

  bridge.invoke = async () => ({ workspace: store });
  assert.equal((await loadWorkspace()).warning, undefined);
});
