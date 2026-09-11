import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  LEGACY_KEYS,
  Workspace,
  normalizeWorkspace,
  hasDependencyCycle,
} from "./workspace";
export interface LoadResult {
  workspace: Workspace;
  warning?: string;
}
export async function loadWorkspace(): Promise<LoadResult> {
  if (isTauri()) {
    const result = await invoke<{
      workspace: unknown;
      recovered?: boolean;
      credentials?: string;
    }>("load_workspace");
    if (result.workspace)
      return {
        workspace: normalizeWorkspace(result.workspace),
        // A locked credential vault is reported on its own: the workspace
        // itself loaded, only the saved secrets had to be dropped.
        warning:
          result.credentials ??
          (result.recovered
            ? "Recovered the last known good workspace. Review your recent changes."
            : undefined),
      };
  }
  for (const key of LEGACY_KEYS) {
    const text = localStorage.getItem(key);
    if (!text) continue;
    try {
      return {
        workspace: normalizeWorkspace(JSON.parse(text)),
        warning:
          "Your existing workspace has been migrated. Interrupted sessions are ready to restart.",
      };
    } catch {
      /* try the prior schema */
    }
  }
  return { workspace: normalizeWorkspace({}) };
}
let pending: Workspace | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let chain: Promise<void> = Promise.resolve();
let savingHandler: (saving: boolean) => void = () => {};
export function onStorageSaving(handler: (saving: boolean) => void) {
  savingHandler = handler;
}
let errorHandler: (error?: string) => void = () => {};
export function onStorageError(handler: (error?: string) => void) {
  errorHandler = handler;
}
export function scheduleSave(workspace: Workspace) {
  pending = workspace;
  savingHandler(true);
  clearTimeout(timer);
  timer = setTimeout(() => {
    void flushSave().catch(() => {});
  }, 300);
}
export function flushSave(): Promise<void> {
  clearTimeout(timer);
  const snapshot = pending;
  pending = undefined;
  if (!snapshot) return chain;
  chain = chain
    .catch(() => {})
    .then(async () => {
      if (!isTauri()) return; // Browser preview never stores credentials or overwrites desktop data.
      try {
        await invoke("save_workspace", { workspace: snapshot });
        for (const key of LEGACY_KEYS) localStorage.removeItem(key);
        errorHandler(undefined);
        if (!pending) savingHandler(false);
      } catch (e) {
        pending ??= snapshot;
        errorHandler(String(e));
        throw e;
      }
    });
  return chain;
}
export function parseBackup(text: string): Workspace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  const result = normalizeWorkspace(parsed, true);
  if (hasDependencyCycle(result.tasks))
    throw new Error("The backup contains circular task dependencies.");
  return result;
}
