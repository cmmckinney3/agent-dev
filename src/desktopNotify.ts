// Desktop notifications through the native plugin. Best effort: a refused
// permission or an unavailable notification service never interrupts work, and
// the in-app Dashboard still shows the same status.
import { isTauri } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let permission: Promise<boolean> | undefined;

/** Asks for permission the first time it is needed, then sends. */
export async function notifyDesktop(title: string, body: string) {
  if (!isTauri()) return;
  permission ??= (async () =>
    (await isPermissionGranted()) ||
    (await requestPermission()) === "granted")();
  try {
    if (await permission) sendNotification({ title, body });
  } catch {
    // Ask again next time rather than remembering a transient failure.
    permission = undefined;
  }
}
