import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Settings } from "./settings";
import { RunRecord } from "./usage";
import {
  ActivityState,
  activityChanged,
  initialActivity,
  onAttention,
  onBell,
  onExit,
  onInput,
  onOutput,
  onResize,
  onSeen,
  onTick,
  SCREEN_LINES,
} from "./activity";

export type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "exited"
  | "failed";
export const isBusy = (status?: AgentStatus) =>
  status === "starting" || status === "running" || status === "stopping";
export interface SessionEvent {
  id: string;
  status: AgentStatus;
  run?: RunRecord;
  exitCode?: number;
  error?: string;
  attention?: string;
  completed?: boolean;
  recordingError?: string;
  recordingRunId?: string;
}
export interface Launch {
  program: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  run: RunRecord;
  /** The launch carries a prompt, so the agent starts working on a turn. */
  seeded?: boolean;
}
export interface Session {
  id: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  status: AgentStatus;
  run?: RunRecord;
  error?: string;
  hasOutput: boolean;
  /** What the agent is doing; kept after exit so a finished run reads as Done. */
  activity?: ActivityState;
  showSearch?: () => void;
  launching?: Promise<boolean>;
  stopping?: Promise<void>;
}
const sessions = new Map<string, Session>();
const listeners = new Set<(event: SessionEvent) => void>();
const activityListeners = new Set<
  (id: string, activity: ActivityState | undefined) => void
>();
let bridgeReady: Promise<void> | undefined;
const publish = (session: Session, extra: Partial<SessionEvent> = {}) => {
  const event = {
    id: session.id,
    status: session.status,
    run: session.run,
    error: session.error,
    ...extra,
  };
  for (const listener of listeners) listener(event);
};
export function subscribeSessions(
  fn: (event: SessionEvent) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
/** Store a session's activity, telling listeners only about real transitions. */
const setActivity = (s: Session, next: ActivityState | undefined) => {
  const previous = s.activity;
  s.activity = next;
  if (next === previous) return;
  if (next && previous && !activityChanged(previous, next)) return;
  for (const listener of activityListeners) listener(s.id, next);
};
const touch = (s: Session, fn: (a: ActivityState) => ActivityState) => {
  if (s.activity) setActivity(s, fn(s.activity));
};
export function subscribeActivity(
  fn: (id: string, activity: ActivityState | undefined) => void,
): () => void {
  activityListeners.add(fn);
  return () => {
    activityListeners.delete(fn);
  };
}
export function sessionActivity(id: string): ActivityState | undefined {
  return sessions.get(id)?.activity;
}
/** The last non-empty screen lines, with soft-wrapped rows joined back up. */
export function screenTail(term: Terminal, count = SCREEN_LINES): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  let row = buffer.baseY + term.rows - 1;
  while (row >= buffer.baseY && lines.length < count) {
    let text = "";
    for (;;) {
      const line = buffer.getLine(row);
      text = (line?.translateToString(true) ?? "") + text;
      row--;
      if (!line?.isWrapped || row < buffer.baseY) break;
    }
    if (text.trim()) lines.unshift(text);
  }
  return lines;
}
/**
 * Advance every live session's activity clock. App calls this about once a
 * second, so this module holds no timers of its own.
 */
export function tickActivity(now = Date.now()) {
  for (const s of sessions.values())
    if (s.status === "running")
      touch(s, (a) => onTick(a, now, () => screenTail(s.term)));
}
/** The user looked at this pane. */
export function markSeen(id: string, now = Date.now()) {
  const s = sessions.get(id);
  if (s) touch(s, (a) => onSeen(a, now));
}
export function sessionState(id: string): AgentStatus {
  return sessions.get(id)?.status ?? "idle";
}
export function sessionRun(id: string) {
  return sessions.get(id)?.run;
}

function ensureBridge() {
  if (!bridgeReady)
    bridgeReady = (async () => {
      if (!isTauri())
        throw new Error("Launch Crucible as a desktop app to run agents.");
      const installed: (() => void)[] = [];
      try {
        installed.push(await listen<{id:string;run_id:string;error?:string}>("run-saved", e=>{
          const s=sessions.get(e.payload.id);
          if(s&&e.payload.error) publish(s,{recordingError:e.payload.error,recordingRunId:e.payload.run_id});
        }));
        installed.push(
          await listen<{ id: string; data: string; run_id: string }>(
            "agent-output",
            (e) => {
              const s = sessions.get(e.payload.id);
              if (!s || s.run?.id !== e.payload.run_id) return;
              s.hasOutput = true;
              const binary = atob(e.payload.data);
              const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
              s.term.write(bytes);
              touch(s, (a) => onOutput(a, Date.now()));
            },
          ),
        );
        installed.push(
          await listen<{ id: string; code: number | null; run_id: string }>(
            "agent-exit",
            (e) => {
              const s = sessions.get(e.payload.id);
              if (!s || s.run?.id !== e.payload.run_id) return;
              s.status = "exited";
              touch(s, (a) =>
                onExit(
                  a,
                  Date.now(),
                  e.payload.code
                    ? `Exited with code ${e.payload.code}`
                    : "Process exited",
                ),
              );
              s.term.writeln(
                `\r\n\x1b[90m[Process exited${e.payload.code == null ? "" : ` · code ${e.payload.code}`}]\x1b[0m`,
              );
              publish(s, { exitCode: e.payload.code ?? undefined, completed:true });
            },
          ),
        );
      } catch (error) {
        installed.forEach((un) => un());
        bridgeReady = undefined;
        throw error;
      }
    })();
  return bridgeReady;
}
export function configureSession(s: Session, settings: Settings) {
  s.term.options.fontFamily =
    settings.fontFamily || '"Cascadia Code", "Consolas", monospace';
  s.term.options.fontSize = settings.fontSize;
  s.term.options.cursorStyle = settings.cursorStyle;
  s.term.options.cursorBlink = settings.cursorBlink;
  s.term.options.scrollback = settings.scrollback;
}
export function getSession(id: string, settings: Settings): Session {
  const existing = sessions.get(id);
  if (existing) return existing;
  const term = new Terminal({
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily || '"Cascadia Code", "Consolas", monospace',
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    theme: { background: "#0d1117", foreground: "#e6edf3" },
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      if (/^https?:\/\//i.test(uri))
        void openUrl(uri).catch((error) => {
          s.error = String(error);
          publish(s);
        });
    }),
  );
  const s: Session = {
    id,
    term,
    fit,
    search,
    status: "idle",
    hasOutput: false,
  };
  sessions.set(id, s);
  term.onData((data) => {
    if (s.status === "running") touch(s, (a) => onInput(a, Date.now(), data));
    if (s.status === "running")
      void sendSession(id, data).catch((error) => {
        s.error = `Input could not be delivered: ${String(error)}`;
        publish(s);
      });
  });
  term.attachCustomKeyEventHandler((e) => {
    if (
      e.type === "keydown" &&
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === "f"
    ) {
      s.showSearch?.();
      return false;
    }
    // Reserve app shortcuts with Shift so regular terminal controls remain intact.
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      ["p", "n", "b", "e", "d"].includes(e.key.toLowerCase())
    )
      return false;
    return true;
  });
  term.parser.registerOscHandler(9, (message) => {
    if (s.status === "running") {
      touch(s, (a) =>
        onAttention(a, Date.now(), message || "Agent requested attention"),
      );
      publish(s, {
        attention: message.slice(0, 300) || "Agent requested attention",
      });
    }
    return true;
  });
  term.onBell(() => {
    if (s.status === "running") touch(s, (a) => onBell(a, Date.now()));
  });
  return s;
}
export function fitSession(s: Session) {
  if (
    !s.term.element?.parentElement ||
    s.term.element.parentElement.clientWidth < 20 ||
    s.term.element.parentElement.clientHeight < 20
  )
    return;
  s.fit.fit();
  // The agent redraws after a resize; that output is not work.
  touch(s, (a) => onResize(a, Date.now()));
  if (isTauri() && isBusy(s.status))
    void invoke("resize_agent", {
      id: s.id,
      cols: s.term.cols,
      rows: s.term.rows,
    }).catch(() => {});
}
export async function startSession(
  id: string,
  launch: Launch,
  settings: Settings,
): Promise<boolean> {
  const s = getSession(id, settings);
  if (isBusy(s.status)) return false;
  s.status = "starting";
  s.error = undefined;
  s.run = launch.run;
  setActivity(s, initialActivity(Date.now(), Boolean(launch.seeded)));
  publish(s);
  const launching = (async () => { try {
    await ensureBridge();
    if (!launch.cwd.trim())
      throw new Error("Choose a project folder before starting an agent.");
    s.term.reset();
    s.hasOutput = false;
    fitSession(s);
    await invoke("spawn_agent", {
      id,
      runId: launch.run.id,
      recordOutput: settings.recordUsage,
      program: launch.program,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      cols: Math.max(s.term.cols, 20),
      rows: Math.max(s.term.rows, 5),
    });
    // An instant exit can arrive before the invoke promise resolves.
    if (s.run?.id === launch.run.id && s.status === "starting") {
      s.status = "running";
      publish(s);
    }
    s.term.focus();
    return true;
  } catch (error) {
    s.status = "failed";
    s.error = String(error);
    s.hasOutput = true;
    touch(s, (a) => onExit(a, Date.now(), "Could not start"));
    s.term.writeln(`\r\n\x1b[31m[Could not start: ${s.error}]\x1b[0m`);
    publish(s, {completed:true});
    return false;
  } })();
  s.launching = launching;
  try { return await launching; } finally { s.launching = undefined; }
}
export async function stopSession(id: string): Promise<void> {
  const s = sessions.get(id);
  if (!s || !isBusy(s.status)) return;
  if (s.stopping) return s.stopping;
  if (s.launching) await s.launching;
  if (s.stopping) return s.stopping;
  if (!isBusy(s.status)) return;
  const previous = s.status;
  s.status = "stopping";
  publish(s);
  const stopping = (async () => { try {
    await invoke("kill_agent", { id });
    s.status = "stopped";
    touch(s, (a) => onExit(a, Date.now(), "Stopped", true));
    publish(s, {completed:true});
  } catch (error) {
    s.status = previous;
    s.error = `Could not stop: ${String(error)}`;
    publish(s);
    throw error;
  } })();
  s.stopping = stopping;
  try { await stopping; } finally { s.stopping = undefined; }
}
export async function sendSession(id: string, data: string): Promise<void> {
  if (sessions.get(id)?.status !== "running")
    throw new Error("Session is not running");
  await invoke("write_to_agent", { id, data });
}
export function focusSession(id: string) {
  sessions.get(id)?.term.focus();
}
export function disposeSession(id: string) {
  const s = sessions.get(id);
  if (s && !isBusy(s.status)) {
    setActivity(s, undefined);
    s.term.dispose();
    sessions.delete(id);
  }
}
