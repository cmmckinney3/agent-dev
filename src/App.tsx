import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import AgentPane from "./AgentPane";
import AgentManager from "./AgentManager";
import TaskBoard from "./TaskBoard";
import TaskComposer from "./TaskComposer";
import TaskDetail from "./TaskDetail";
import Modal from "./Modal";
import CommandPalette, { PaletteAction } from "./CommandPalette";
import RunReview, { ReviewData } from "./RunReview";
import SplitDivider from "./SplitDivider";
import Dashboard, { DashboardRow } from "./Dashboard";
import { ACTIVITY_LABELS, ActivityState } from "./activity";
import { notifyDesktop } from "./desktopNotify";
import { Teammate, mergeMemory, runFolder, teammatePrompt } from "./teammates";
import {
  arrival,
  Arrival,
  draftKey,
  inboxText,
  messagesToDeliver,
  messageTaskFor,
  messageTaskTitle,
  messageTaskWaits,
  nextHop,
  OWNER,
  pendingMessageTask,
  readOutbox,
  retainMessages,
  senderName,
  TeamMessage,
  tidyBody,
  waitingFor,
} from "./messages";
import {
  AgentConfig,
  AgentDraft,
  enabledAgents,
  isClaudeCode,
  launchBlockReason,
  launchEnv,
  PROMPT_TOKEN,
  resolveTokens,
  seedArgs,
  withHookSettings,
} from "./agents";
import {
  applyPreset,
  LAYOUT_PRESETS,
  MAX_PANES,
  movePane,
  movePaneStep,
  PaneDropPlacement,
  PaneMoveDirection,
  paneIds,
  removePane,
  splitColumn,
  splitPane,
  withColumnSizes,
  withPaneSizes,
} from "./layout";
import {
  Task,
  TaskDraft,
  TaskStatus,
  draftFromTask,
  launchPrompt,
} from "./tasks";
import {
  buildReviewPrompt,
  ParsedVerdict,
  parseVerdict,
  ReviewFile,
  reviewsOf,
  reviewTaskFor,
  VERDICT_LABELS,
} from "./review";
import { RunRecord } from "./usage";
import {
  AgentStatus,
  disposeSession,
  focusSession,
  isBusy,
  markSeen,
  sendSession,
  sessionRun,
  sessionState,
  startSession,
  stopSession,
  subscribeActivity,
  subscribeSessions,
  tickActivity,
} from "./sessions";
import {
  basename,
  hasDependencyCycle,
  makeProject,
  newId,
  normalizeWorkspace,
  Project,
  queueCandidates,
  redactWorkspace,
  retainRuns,
  taskBlocker,
  Workspace,
} from "./workspace";
import {
  flushSave,
  onStorageError,
  onStorageSaving,
  parseBackup,
  scheduleSave,
} from "./storage";
import {
  ActivityIcon,
  BotIcon,
  BroadcastIcon,
  CrucibleIcon,
  DashboardIcon,
  FolderIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  StopIcon,
  TeammatesIcon,
  TerminalIcon,
  CloseIcon,
} from "./icons";
import "./App.css";
import "./Premium.css";
import type { TeammateFocus, TeammateTab } from "./TeammatesPage";
const UsagePage = lazy(() => import("./UsagePage"));
const SettingsPage = lazy(() => import("./SettingsPage"));
const TeammatesPage = lazy(() => import("./TeammatesPage"));
type Page = "workspace" | "teammates" | "activity" | "settings";
/** Width of the Dashboard column beside the panes. */
const DASHBOARD_WIDTH = 300;
/** Below this window width the Dashboard floats over the panes instead. */
const DASHBOARD_DOCK_MIN = 1100;
interface ProjectInfo {
  name: string;
  cwd: string;
  branch?: string;
  git: boolean;
  dirty: boolean;
  /** Git refused the folder for a reason other than "no repository here". */
  gitError?: string;
}
interface Toast {
  message: string;
  action?: () => void;
  label?: string;
}
/** A teammate's run in progress: what its folder holds and what it has sent. */
interface TeamRun {
  teammateId: string;
  cwd: string;
  /** Its folder under `.crucible` (runFolder). */
  folder: string;
  /** The memory as seeded, so the merge can tell its edits from the owner's. */
  seeded: string;
  /** It has an outbox to read. */
  outbox: boolean;
  /** The hop its messages carry (see messages.ts). */
  hop: number;
  projectId?: string;
  /** Keys of messages already sent, and outbox problems already reported. */
  sent: Set<string>;
  reported: Set<string>;
}

export default function App({
  initial,
  warning,
}: {
  initial: Workspace;
  warning?: string;
}) {
  const [w, setW] = useState(initial);
  const latest = useRef(w);
  latest.current = w;
  const [page, setPage] = useState<Page>("workspace");
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [activity, setActivity] = useState<Record<string, ActivityState>>({});
  const [activePane, setActivePane] = useState("");
  /** A pane opened from the Dashboard; `n` restarts the ring animation. */
  const [flash, setFlash] = useState<{ id: string; n: number }>();
  /** The teammate the Teammates page should show, when opened from elsewhere. */
  const [teammateFocus, setTeammateFocus] = useState<TeammateFocus>();
  /** Teammate runs in progress, by run id. */
  const teamRuns = useRef(new Map<string, TeamRun>());
  /** Reads of teammate runs still in flight; closing waits for them. */
  const collecting = useRef(new Set<Promise<void>>());
  /** Path of the Claude Code hook settings file, written once per launch. */
  const hookSettings = useRef<Promise<string | undefined> | undefined>(
    undefined,
  );
  const [expanded, setExpanded] = useState<string>();
  const [agentManager, setAgentManager] = useState(false);
  const [palette, setPalette] = useState(false);
  const [composer, setComposer] = useState<{ id?: string; key: string }>();
  const [detail, setDetail] = useState<string>();
  const [runDetail, setRunDetail] = useState<string>();
  const [toast, setToast] = useState<Toast | undefined>(
    warning ? { message: warning } : undefined,
  );
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(true);
  const transitioning = useRef(false);
  const [projectDialog, setProjectDialog] = useState<"new" | "edit">();
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectError, setProjectError] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo>();
  const [infoError, setInfoError] = useState("");
  const [infoRefresh, setInfoRefresh] = useState(0);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcast, setBroadcast] = useState("");
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [delivery, setDelivery] = useState<string>();
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [viewport, setViewport] = useState(window.innerWidth);
  const [dragSlot, setDragSlot] = useState<string>();
  const [dropHint, setDropHint] = useState<{
    id: string;
    placement: PaneDropPlacement;
  }>();
  const attentionRef = useRef<HTMLElement>(null);
  const attentionTrigger = useRef<HTMLButtonElement>(null);
  const launches = useRef(new Set<string>());
  const reservations = useRef(new Set<string>());
  const operationEpoch = useRef(0);
  const cancelled = useRef(new Set<string>());
  const queueRunning = useRef(false);
  const reviewing = useRef(new Set<string>());
  const [queueTick, setQueueTick] = useState(0);
  const project = w.projects.find((p) => p.id === w.activeProjectId)!;
  const order = paneIds(project.layout);
  // The rail is sized in pixels, so in a narrow window its own maximum has to
  // shrink or the panes it sits next to become unusably thin.
  // A docked Dashboard takes its width from the panes; in a narrow window it
  // floats over them instead, so the panes never shrink below usable.
  const dashboardDocked = w.dashboardOpen && viewport >= DASHBOARD_DOCK_MIN;
  const railMax = Math.max(
    240,
    Math.min(480, viewport - 560 - (dashboardDocked ? DASHBOARD_WIDTH : 0)),
  );
  const clampRail = (width: number) => Math.max(240, Math.min(railMax, width));
  const allSlots = w.projects.flatMap((p) => paneIds(p.layout));
  const available = enabledAgents(w.agents);
  const running = allSlots.filter((id) => isBusy(statuses[id]));
  const projectRunning = order.filter((id) => isBusy(statuses[id]));
  const attention = w.tasks.filter(
    (t) =>
      !t.archived && (t.attention || t.interrupted || t.status === "review"),
  );
  const currentTasks = w.tasks.filter((t) => t.projectId === project.id);
  const selectedTask = w.tasks.find((t) => t.id === detail);
  const selectedRun = w.usage.find((r) => r.id === runDetail);
  const notify = (message: string, action?: () => void, label?: string) =>
    setToast({ message, action, label });
  const change = (fn: (value: Workspace) => Workspace) => {
    const next = fn(latest.current);
    latest.current = next;
    setW(next);
  };
  const patchProject = (id: string, fn: (p: Project) => Project) =>
    change((v) => ({
      ...v,
      projects: v.projects.map((p) => (p.id === id ? fn(p) : p)),
    }));
  const patchTask = (id: string, patch: Partial<Task>) =>
    change((v) => ({
      ...v,
      tasks: v.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  const showTask = (id: string) => {
    setDetail(id);
    setRunDetail(undefined);
    setAttentionOpen(false);
  };
  const openRun = (id: string) => {
    setDetail(undefined);
    setRunDetail(id);
  };
  const newTask = () => {
    setComposer({ key: newId("draft") });
    setPage("workspace");
  };

  useEffect(() => {
    onStorageError(setSaveError);
    onStorageSaving(setSaving);
    scheduleSave(w);
  }, [w]);
  const closeAttention = () => {
    setAttentionOpen(false);
    attentionTrigger.current?.focus();
  };
  useEffect(() => {
    if (!attentionOpen) return;
    attentionRef.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeAttention();
      }
    };
    const pointer = (e: PointerEvent) => {
      if (
        !attentionRef.current?.contains(e.target as Node) &&
        !attentionTrigger.current?.contains(e.target as Node)
      )
        setAttentionOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", pointer);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", pointer);
    };
  }, [attentionOpen]);
  useEffect(() => {
    if (!toast || toast.action) return;
    const timer = setTimeout(() => setToast(undefined), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    let valid = true;
    setProjectInfo(undefined);
    setInfoError("");
    if (project.cwd && isTauri())
      void invoke<ProjectInfo>("project_info", { cwd: project.cwd })
        .then((info) => {
          if (valid) setProjectInfo(info);
        })
        .catch((e) => {
          if (valid) setInfoError(String(e));
        });
    return () => {
      valid = false;
    };
  }, [project.cwd, infoRefresh]);
  useEffect(() => {
    const refresh = () => setInfoRefresh((n) => n + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(
    () =>
      subscribeSessions((event) => {
        if (event.recordingError && event.recordingRunId) {
          const message = `Recording needs attention: ${event.recordingError}`;
          change((v) => ({
            ...v,
            usage: v.usage.map((r) =>
              r.id === event.recordingRunId ? { ...r, error: message } : r,
            ),
          }));
          notify(message);
        }
        setStatuses((prev) => ({ ...prev, [event.id]: event.status }));
        if (event.attention && event.run?.taskId) {
          change((v) => ({
            ...v,
            tasks: v.tasks.map((t) =>
              t.id === event.run?.taskId
                ? { ...t, attention: event.attention }
                : t,
            ),
          }));
          notify(
            event.attention,
            () => showTask(event.run!.taskId!),
            "Open task",
          );
        }
        const finished = ["exited", "stopped", "failed"].includes(event.status);
        if (finished && event.run && event.completed) {
          const outcome =
            event.status === "failed"
              ? "failed"
              : event.status === "stopped"
                ? "stopped"
                : "completed";
          change((v) => ({
            ...v,
            usage: retainRuns(
              v.usage.map((r) =>
                r.id === event.run!.id
                  ? {
                      ...r,
                      outcome,
                      endedAt: Date.now(),
                      exitCode: event.exitCode,
                      error: event.error ?? r.error,
                    }
                  : r,
              ),
              v.settings.usageLimit,
            ),
            tasks: v.tasks.map((t) => {
              if (t.id !== event.run?.taskId || t.paneId !== event.id) return t;
              const status: TaskStatus =
                event.status === "failed"
                  ? "backlog"
                  : event.status === "stopped"
                    ? "backlog"
                    : t.mode === "headless" &&
                        v.settings.headlessCompletion !== "stay"
                      ? v.settings.headlessCompletion === "done-on-success" &&
                        event.exitCode === 0
                        ? "done"
                        : "review"
                      : t.status;
              return {
                ...t,
                status,
                paneId: undefined,
                queued: false,
                lastExitCode: event.exitCode,
                // Reaching Done closes the review loop; a later re-run starts clean.
                changeRequest: status === "done" ? undefined : t.changeRequest,
                attention:
                  event.status === "failed"
                    ? (event.error ?? "Failed to start")
                    : event.status === "stopped"
                      ? "Stopped"
                      : status === "done"
                        ? undefined
                        : event.exitCode
                          ? `Process exited with code ${event.exitCode}`
                          : "Ready for your review",
              };
            }),
          }));
          setInfoRefresh((n) => n + 1);
          if (event.status !== "stopped") {
            notify(
              `${event.run.taskTitle || event.run.session}: ${event.status === "failed" ? "could not start" : "run finished"}`,
              () =>
                event.run?.taskId
                  ? showTask(event.run.taskId)
                  : setRunDetail(event.run!.id),
              "Review",
            );
            if (latest.current.settings.notifyOnCompletion && isTauri())
              void getCurrentWindow()
                .requestUserAttention(UserAttentionType.Informational)
                .catch(() => {});
          }
          // The output log is synced before agent-exit is sent, so it is
          // complete by now.
          if (event.status === "exited") void readVerdict(event.run);
          // A stopped run may still have learned something or written to a
          // teammate; collect either way.
          void collectTeamRun(event.run.id, true);
        }
      }),
    [],
  );

  useEffect(() => {
    const unsubscribe = subscribeActivity((id, state) => {
      setActivity((prev) => {
        const next = { ...prev };
        if (state) next[id] = state;
        else delete next[id];
        return next;
      });
      // A teammate that finished a turn (or stopped to ask) may have written
      // to its outbox: deliver now rather than when the whole run ends.
      // (An ended run is collected by its exit event instead.)
      const live = sessionRun(id);
      if (
        state &&
        state.activity !== "working" &&
        live &&
        sessionState(id) === "running"
      )
        void collectTeamRun(live.id, false);
      // Done stays until the pane is clicked or typed in: every launch focuses
      // its terminal, so "the active pane" is no proof anyone saw it finish.
      if (!state || (state.activity !== "waiting" && state.activity !== "done"))
        return;
      const mode = latest.current.settings.desktopNotifications;
      if (mode === "off" || (mode === "background" && document.hasFocus()))
        return;
      const p = slotProject(id);
      const run = sessionRun(id);
      const name = run?.taskTitle || p?.slotNames[id] || "Session";
      void notifyDesktop(
        `${ACTIVITY_LABELS[state.activity]}: ${name}`,
        [[run?.agentName, p?.name].filter(Boolean).join(" · "), state.reason]
          .filter(Boolean)
          .join("\n"),
      );
    });
    const timer = window.setInterval(() => tickActivity(), 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(undefined), 1600);
    return () => clearTimeout(timer);
  }, [flash]);

  /**
   * An agent review just finished: read its APPROVE / REQUEST CHANGES line from
   * the saved output and record it on the review, flagging the reviewed task.
   * Nothing is sent anywhere; the owner decides what to do with the findings.
   */
  const readVerdict = async (run: RunRecord) => {
    const review = latest.current.tasks.find((t) => t.id === run.taskId);
    if (!review?.reviewOf) return;
    let parsed: ParsedVerdict | undefined;
    let problem: string | undefined;
    if (!isTauri() || !latest.current.settings.recordUsage)
      problem =
        "Run recording is off, so the verdict could not be read. Check the reviewer's session for it.";
    else
      try {
        const data = await invoke<ReviewData>("read_run", {
          runId: run.id,
          refresh: false,
        });
        parsed = parseVerdict(data.output, run.prompt);
        if (!parsed)
          problem = data.truncated
            ? "The review output was too long to read a verdict from."
            : "No APPROVE or REQUEST CHANGES line found in the review output.";
      } catch (e) {
        problem = `Could not read the review output: ${String(e)}`;
      }
    const verdict = parsed && { ...parsed, runId: run.id, at: Date.now() };
    change((v) => ({
      ...v,
      tasks: v.tasks.map((t) => {
        // With a verdict the review card's job is done: its findings now show
        // on the reviewed task, so it leaves the Review column (unless headless
        // runs are set to stay put).
        // A re-run started while the output was being read owns the card now.
        if (t.id === review.id && !t.paneId)
          return verdict
            ? {
                ...t,
                verdict,
                attention: undefined,
                status:
                  v.settings.headlessCompletion === "stay" ? t.status : "done",
              }
            : { ...t, verdict: undefined, attention: problem };
        if (verdict && t.id === review.reviewOf && !t.paneId)
          return {
            ...t,
            attention:
              verdict.decision === "approve"
                ? "Agent review approved"
                : "Agent review requested changes",
          };
        return t;
      }),
    }));
    const reviewed = latest.current.tasks.find((t) => t.id === review.reviewOf);
    if (verdict && reviewed)
      notify(
        `Review of “${reviewed.title}”: ${VERDICT_LABELS[verdict.decision].toLowerCase()}`,
        () => showTask(reviewed.id),
        "Open task",
      );
    else if (problem) notify(problem, () => showTask(review.id), "Open review");
  };

  const openTeammate = (id?: string, tab?: TeammateTab) => {
    setTeammateFocus({ id, tab, n: Date.now() });
    setPage("teammates");
    setDetail(undefined);
    setRunDetail(undefined);
  };
  /**
   * Read a teammate run's folder. Mid-run (`final` false) only the outbox
   * matters: new messages are sent. When the run ends its memory is folded
   * back too (see mergeMemory for how edits on both sides are kept) and the
   * folder is removed.
   */
  const collectTeamRun = (runId: string, final: boolean) => {
    const job = readTeamRun(runId, final);
    collecting.current.add(job);
    void job.finally(() => collecting.current.delete(job));
    return job;
  };
  const readTeamRun = async (runId: string, final: boolean) => {
    const team = teamRuns.current.get(runId);
    if (!team || (!final && !team.outbox)) return;
    if (final) teamRuns.current.delete(runId);
    const name = () =>
      latest.current.teammates.find((t) => t.id === team.teammateId)?.name ??
      "The teammate";
    let files: { memory: string | null; outbox: string | null };
    try {
      files = await invoke<{ memory: string | null; outbox: string | null }>(
        "collect_teammate_run",
        {
          cwd: team.cwd,
          folder: team.folder,
          remove: final,
        },
      );
    } catch (e) {
      if (final) notify(`Could not read ${name()}'s memory: ${String(e)}`);
      return;
    }
    const mate = latest.current.teammates.find((t) => t.id === team.teammateId);
    let memoryNote: string | undefined;
    if (final && mate) {
      const merged = mergeMemory(team.seeded, mate.memory, files.memory);
      if (merged.changed) {
        change((v) => ({
          ...v,
          teammates: v.teammates.map((t) =>
            t.id === mate.id
              ? { ...t, memory: merged.memory, memoryUpdatedAt: Date.now() }
              : t,
          ),
        }));
        memoryNote = `${mate.name}'s memory was updated${merged.trimmed ? "; the oldest notes were dropped to fit" : ""}.`;
      }
    }
    // There is one toast: messages sent now carry the memory note with them.
    const sent =
      team.outbox && files.outbox
        ? postOutbox(runId, team, files.outbox, memoryNote)
        : false;
    if (!sent && memoryNote && mate)
      notify(memoryNote, () => openTeammate(mate.id, "memory"), "View memory");
  };
  /** Send what a run wrote in its outbox since it was last read. */
  const postOutbox = (
    runId: string,
    team: TeamRun,
    text: string,
    note?: string,
  ): boolean => {
    const state = latest.current;
    const sender = state.teammates.find((t) => t.id === team.teammateId);
    if (!sender) return false;
    const read = readOutbox(text, sender, state.teammates, team.sent);
    for (const draft of read.drafts) team.sent.add(draftKey(draft));
    const problems = read.problems.filter((p) => !team.reported.has(p));
    problems.forEach((p) => team.reported.add(p));
    if (!read.drafts.length && !problems.length) return false;
    const now = Date.now();
    sendMessages(
      read.drafts.map((draft) => ({
        id: newId("message"),
        from: sender.id,
        fromName: sender.name,
        to: draft.to,
        body: draft.body,
        at: now,
        projectId: team.projectId,
        cwd: team.cwd,
        runId,
        hop: team.hop,
      })),
      sender.name,
      problems,
      false,
      note,
    );
    return true;
  };
  /**
   * Put messages in their recipients' inboxes and start a task for each
   * recipient that asks for one (see `arrival`), then say what happened in one
   * toast. `force` starts tasks whatever the recipients' settings (the owner
   * asked for it).
   */
  const sendMessages = (
    messages: TeamMessage[],
    fromName: string,
    problems: string[] = [],
    force = false,
    note?: string,
  ) => {
    const state = latest.current;
    const fallback = state.projects.find(
      (p) => p.id === state.activeProjectId,
    )!;
    const tasks = [...state.tasks];
    const fresh: Task[] = [];
    const notes: string[] = [];
    const taskOf = new Map<string, string>();
    for (const to of [...new Set(messages.map((m) => m.to))]) {
      const mate = state.teammates.find((t) => t.id === to);
      if (!mate) continue;
      const group = messages.filter((m) => m.to === to);
      const hop = Math.max(...group.map((m) => m.hop));
      const how: Arrival = force ? "start" : arrival(mate, hop, state.settings);
      if (how !== "start") {
        notes.push(
          `${mate.name}: ${
            how === "paused"
              ? "waits (Settings has paused message tasks)"
              : how === "chain"
                ? `waits (this chain of messages reached its limit of ${state.settings.messageChainLimit})`
                : "waits for its next task"
          }`,
        );
        continue;
      }
      const project =
        state.projects.find((p) => p.id === group[0].projectId) ?? fallback;
      const where = {
        projectId: project.id,
        cwd: group[0].projectId === project.id ? group[0].cwd : undefined,
      };
      const pending = pendingMessageTask(tasks, mate.id, where);
      if (pending) {
        const ids = [...(pending.messageIds ?? []), ...group.map((m) => m.id)];
        const all = [
          ...state.messages.filter((m) => pending.messageIds?.includes(m.id)),
          ...group,
        ];
        const merged: Task = {
          ...pending,
          messageIds: ids,
          hop: Math.max(pending.hop ?? 1, hop),
          title: messageTaskTitle(
            all.map((m) =>
              m.from === OWNER ? "you" : senderName(m, state.teammates),
            ),
            ids.length,
          ),
        };
        tasks[tasks.indexOf(pending)] = merged;
        group.forEach((m) => taskOf.set(m.id, merged.id));
        notes.push(`${mate.name}: added to its waiting task`);
        continue;
      }
      const task = messageTaskFor(mate, group, state.teammates, where, {
        id: newId("task"),
        now: Date.now(),
      });
      tasks.push(task);
      fresh.push(task);
      group.forEach((m) => taskOf.set(m.id, task.id));
      notes.push(
        `${mate.name}: ${
          messageTaskWaits(task, tasks, state.projects)
            ? "task queued until its current one ends"
            : "task created"
        }`,
      );
    }
    // A message sent again (a task started by hand) is updated in place.
    const updated = new Map(
      messages.map((m) => [
        m.id,
        taskOf.has(m.id) ? { ...m, taskId: taskOf.get(m.id) } : m,
      ]),
    );
    change((v) => {
      const known = new Set(v.messages.map((m) => m.id));
      return {
        ...v,
        tasks,
        messages: retainMessages([
          ...v.messages.map((m) => updated.get(m.id) ?? m),
          ...[...updated.values()].filter((m) => !known.has(m.id)),
        ]),
      };
    });
    for (const task of fresh) void startTask(task.id);
    const first = messages[0];
    const opened = first && taskOf.get(first.id);
    const count =
      messages.length === 1 ? "Message" : `${messages.length} messages`;
    const text = [
      messages.length ? `${count} from ${fromName}. ${notes.join("; ")}.` : "",
      problems.length ? `Not delivered: ${problems.join(" ")}` : "",
      note ?? "",
    ]
      .filter(Boolean)
      .join(" ");
    if (opened) notify(text, () => showTask(opened), "Open task");
    else if (first)
      notify(text, () => openTeammate(first.to, "messages"), "View");
    else
      notify(
        `${fromName}'s outbox: ${text}`,
        () =>
          openTeammate(
            state.teammates.find((t) => t.name === fromName)?.id,
            "messages",
          ),
        "View",
      );
  };
  /** The owner writes to a teammate from its page. */
  const sendOwnerMessage = (to: string, text: string) => {
    const body = tidyBody(text);
    const state = latest.current;
    const p = state.projects.find((p) => p.id === state.activeProjectId);
    if (!body || !state.teammates.some((t) => t.id === to)) return;
    sendMessages(
      [
        {
          id: newId("message"),
          from: OWNER,
          fromName: "You",
          to,
          body,
          at: Date.now(),
          projectId: p?.id,
          cwd: p?.cwd || undefined,
          hop: 1,
        },
      ],
      "you",
    );
  };
  /** Start a task for a waiting message now, whatever the recipient's setting. */
  const startFromMessage = (id: string) => {
    const message = latest.current.messages.find((m) => m.id === id);
    const task = latest.current.tasks.find((t) => t.id === message?.taskId);
    if (!message || message.deliveredAt || (task && !task.archived)) return;
    sendMessages(
      [message],
      message.from === OWNER
        ? "you"
        : senderName(message, latest.current.teammates),
      [],
      true,
    );
  };
  const deleteMessage = (id: string) =>
    change((v) => ({ ...v, messages: v.messages.filter((m) => m.id !== id) }));

  const slotProject = (id: string) =>
    latest.current.projects.find((p) => paneIds(p.layout).includes(id));
  const slotTitle = (id: string) => slotProject(id)?.slotNames[id] || "Session";
  const showSession = (id: string) => {
    const p = slotProject(id);
    if (p) {
      change((v) => ({ ...v, activeProjectId: p.id }));
      setActivePane(id);
      setExpanded(id);
      setPage("workspace");
      setDetail(undefined);
      setRunDetail(undefined);
      requestAnimationFrame(() => focusSession(id));
    }
  };
  const switchProject = (id: string) => {
    change((v) => ({
      ...v,
      activeProjectId: id,
      projects: v.projects.map((p) =>
        p.id === id ? { ...p, lastOpened: Date.now() } : p,
      ),
    }));
    setExpanded(undefined);
    setActivePane("");
    setPage("workspace");
  };
  /** Bring a pane into view from the Dashboard, without focus mode. */
  const openPane = (id: string) => {
    const p = slotProject(id);
    if (!p) return;
    if (p.id !== latest.current.activeProjectId) switchProject(p.id);
    else {
      setPage("workspace");
      if (expanded && expanded !== id) setExpanded(undefined);
    }
    setActivePane(id);
    setDetail(undefined);
    setRunDetail(undefined);
    markSeen(id);
    setFlash({ id, n: Date.now() });
    // A floating Dashboard covers the panes; get out of the way of the one asked for.
    if (window.innerWidth < DASHBOARD_DOCK_MIN)
      change((v) => ({ ...v, dashboardOpen: false }));
    requestAnimationFrame(() => focusSession(id));
  };
  const toggleDashboard = () => {
    if (page !== "workspace") {
      setPage("workspace");
      change((v) => ({ ...v, dashboardOpen: true }));
    } else change((v) => ({ ...v, dashboardOpen: !v.dashboardOpen }));
  };
  const stop = async (id: string) => {
    try {
      await stopSession(id);
    } catch (e) {
      notify(String(e));
    }
  };
  const stopAll = async () => {
    if (
      latest.current.settings.confirmStopAll &&
      isTauri() &&
      !(await confirm(
        "Stop all running sessions across all projects? Saved output will remain available.",
        { title: "Stop all sessions", kind: "warning" },
      ))
    )
      return;
    await Promise.all(allSlots.map(stop));
  };
  const createRun = (
    slot: string,
    agentId: string,
    cwd: string,
    task?: Task,
    extra: Partial<RunRecord> = {},
  ): RunRecord => {
    const a = latest.current.agents.find((a) => a.id === agentId)!;
    return {
      id: newId("run"),
      agentId,
      agentName: a.name,
      program: a.program,
      model: a.model || undefined,
      slotId: slot,
      session: slotTitle(slot),
      projectId: task?.projectId || slotProject(slot)?.id,
      cwd,
      taskId: task?.id,
      taskTitle: task?.title,
      prompt: task ? launchPrompt(task) : undefined,
      mode: task?.mode,
      startedAt: Date.now(),
      outcome: "running",
      ...extra,
    };
  };
  /**
   * An interactive Claude Code launch gets Crucible's hooks, so it reports its
   * turns and permission prompts exactly (see desktop.rs and activity.ts).
   * Headless runs are left alone: Claude Code ignores terminal output from
   * hooks with `-p`. Without the file, the launch goes ahead unhooked.
   */
  const withHooks = async (
    agent: AgentConfig,
    args: string[],
  ): Promise<string[]> => {
    if (
      !latest.current.settings.claudeHooks ||
      !isClaudeCode(agent) ||
      !isTauri()
    )
      return args;
    hookSettings.current ??= invoke<string>("claude_hook_settings").catch(
      () => undefined,
    );
    const path = await hookSettings.current;
    // A failed write is retried by the next launch.
    if (!path) hookSettings.current = undefined;
    return path ? withHookSettings(args, path) : args;
  };
  const recordRun = (run: RunRecord) => {
    if (latest.current.settings.recordUsage)
      change((v) => ({
        ...v,
        usage: retainRuns([...v.usage, run], v.settings.usageLimit),
      }));
  };

  const startManual = async (
    slot: string,
    resume?: { run: RunRecord; sessionId: string },
  ) => {
    const state = latest.current;
    const p = slotProject(slot);
    if (
      transitioning.current ||
      !p ||
      isBusy(sessionState(slot)) ||
      reservations.current.has(slot)
    )
      return;
    const a =
      state.agents.find(
        (a) => a.id === (resume?.run.agentId ?? p.slotAgents[slot]),
      ) ?? enabledAgents(state.agents)[0];
    const reason = launchBlockReason(a, state.settings);
    if (reason) {
      notify(reason);
      return;
    }
    const cwd = resume?.run.cwd || p.slotCwds[slot] || p.cwd;
    const run = createRun(slot, a.id, cwd);
    if (resume) {
      run.resumeId = resume.sessionId;
      run.prompt = resume.run.prompt;
    }
    const base = resume
      ? a.program === "codex"
        ? ["resume", resume.sessionId]
        : ["--resume", resume.sessionId]
      : a.interactiveArgs
          .filter((arg) => !arg.includes(PROMPT_TOKEN))
          .map((arg) => resolveTokens(arg, a, state.settings));
    // Held while the hook settings are fetched, so a second click cannot
    // start the pane twice.
    reservations.current.add(slot);
    try {
      const args = await withHooks(a, base);
      if (transitioning.current || isBusy(sessionState(slot))) return;
      patchProject(p.id, (value) => ({
        ...value,
        slotAgents: { ...value.slotAgents, [slot]: a.id },
      }));
      recordRun(run);
      await startSession(
        slot,
        {
          program: a.program,
          cwd,
          args,
          env: launchEnv(a, state.settings),
          run,
        },
        state.settings,
      );
    } finally {
      reservations.current.delete(slot);
    }
  };

  const startTask = async (id: string) => {
    if (transitioning.current || launches.current.has(id)) return;
    const state = latest.current;
    const task = state.tasks.find((t) => t.id === id);
    if (!task || task.archived || task.paneId) return;
    const p = state.projects.find((p) => p.id === task.projectId);
    // A teammate's engine wins over the task's, so changing the teammate's
    // engine moves all of its tasks with it.
    const mate = task.teammateId
      ? state.teammates.find((t) => t.id === task.teammateId)
      : undefined;
    const a = state.agents.find(
      (a) => a.id === (mate?.agentId ?? task.agentId),
    );
    if (!p || !a) return;
    const blocked = launchBlockReason(a, state.settings);
    if (blocked) {
      patchTask(id, { queued: false, attention: blocked });
      notify(blocked);
      return;
    }
    const dependency = taskBlocker(task, state.tasks);
    if (dependency) {
      // Not a refusal: the queue drain picks it up once the dependency is done.
      patchTask(id, { queued: true, status: "backlog" });
      notify(`${dependency}. Queued to start when they finish.`);
      return;
    }
    if (messageTaskWaits(task, state.tasks, state.projects)) {
      // The teammate is busy in this folder; the drain starts it afterwards.
      patchTask(id, { queued: true, status: "backlog" });
      return;
    }
    const bound = new Set(state.tasks.map((t) => t.paneId).filter(Boolean));
    const concurrent = state.tasks.filter(
      (t) =>
        t.paneId &&
        (isBusy(sessionState(t.paneId)) || reservations.current.has(t.paneId)),
    ).length;
    const slot =
      state.settings.maxConcurrentRuns > 0 &&
      concurrent >= state.settings.maxConcurrentRuns
        ? undefined
        : paneIds(p.layout).find(
            (s) =>
              !isBusy(sessionState(s)) &&
              !reservations.current.has(s) &&
              !bound.has(s),
          );
    if (!slot) {
      patchTask(id, { queued: true, status: "backlog" });
      return;
    }
    launches.current.add(id);
    reservations.current.add(slot);
    cancelled.current.delete(id);
    const epoch = operationEpoch.current;
    patchTask(id, {
      paneId: slot,
      status: "running",
      queued: false,
      attention: undefined,
      interrupted: false,
      lastExitCode: undefined,
      verdict: undefined,
    });
    try {
      let cwd = task.cwd || p.cwd;
      if (task.isolation) {
        cwd =
          task.worktree ||
          (await invoke<string>("create_worktree", { cwd, taskId: task.id }));
        patchTask(id, { worktree: cwd });
      }
      if (cancelled.current.has(id) || epoch !== operationEpoch.current) {
        if (epoch === operationEpoch.current)
          patchTask(id, {
            status: "backlog",
            paneId: undefined,
            queued: false,
          });
        return;
      }
      const request = launchPrompt(task);
      let prompt = request;
      const runId = newId("run");
      let delivered: TeamMessage[] = [];
      if (mate) {
        // Memory and messages go into files in the run's own folder, never
        // into argv; the prompt only says where they are.
        const now = latest.current;
        const folder = runFolder(mate, runId);
        const team = now.teammates
          .filter((t) => t.id !== mate.id)
          .map((t) => t.name);
        const outbox = mate.canMessage && team.length > 0;
        delivered = messagesToDeliver(now.messages, mate.id, task.messageIds);
        await invoke("seed_teammate_run", {
          cwd,
          folder,
          memory: mate.memory,
          inbox: delivered.length
            ? inboxText(
                mate,
                delivered,
                now.messages,
                now.teammates,
                now.projects,
              )
            : null,
          outbox,
        });
        teamRuns.current.set(runId, {
          teammateId: mate.id,
          cwd,
          folder,
          seeded: mate.memory,
          outbox,
          hop: nextHop(task),
          projectId: p.id,
          sent: new Set(),
          reported: new Set(),
        });
        prompt = teammatePrompt(mate, request, {
          folder,
          inbox: delivered.length,
          team: outbox ? team : [],
        });
      }
      const seeded = seedArgs(a, prompt, task.mode, state.settings);
      const args =
        task.mode === "interactive" ? await withHooks(a, seeded) : seeded;
      const run = createRun(
        slot,
        a.id,
        cwd,
        task,
        mate
          ? {
              id: runId,
              prompt,
              request,
              teammateId: mate.id,
              teammateName: mate.name,
            }
          : { id: runId },
      );
      recordRun(run);
      patchProject(p.id, (value) => ({
        ...value,
        slotAgents: { ...value.slotAgents, [slot]: a.id },
      }));
      const started = await startSession(
        slot,
        {
          program: a.program,
          cwd,
          args,
          env: launchEnv(a, state.settings),
          run,
          seeded: true,
        },
        state.settings,
      );
      if (started && delivered.length) {
        const ids = new Set(delivered.map((m) => m.id));
        const at = Date.now();
        change((v) => ({
          ...v,
          messages: v.messages.map((m) =>
            ids.has(m.id)
              ? { ...m, deliveredAt: at, deliveredRunId: run.id }
              : m,
          ),
        }));
      }
      // A launch that never became the pane's run is cleaned up here; one that
      // failed to spawn was already collected by its exit event (a no-op now).
      if (!started) void collectTeamRun(run.id, true);
    } catch (e) {
      patchTask(id, {
        status: "backlog",
        paneId: undefined,
        queued: false,
        attention: String(e),
      });
      notify(String(e));
    } finally {
      launches.current.delete(id);
      reservations.current.delete(slot);
      setQueueTick((n) => n + 1);
    }
  };
  useEffect(() => {
    if (
      transitioning.current ||
      !w.settings.autoStartQueued ||
      queueRunning.current
    )
      return;
    const next = queueCandidates(w.tasks).find((t) => {
      const p = w.projects.find((p) => p.id === t.projectId);
      return (
        p &&
        !messageTaskWaits(t, w.tasks, w.projects) &&
        paneIds(p.layout).some(
          (id) =>
            !isBusy(sessionState(id)) &&
            !reservations.current.has(id) &&
            !w.tasks.some((t) => t.paneId === id),
        )
      );
    });
    const count = w.tasks.filter(
      (t) =>
        t.paneId &&
        (isBusy(sessionState(t.paneId)) || reservations.current.has(t.paneId)),
    ).length;
    if (
      !next ||
      (w.settings.maxConcurrentRuns > 0 &&
        count >= w.settings.maxConcurrentRuns)
    )
      return;
    queueRunning.current = true;
    void startTask(next.id).finally(() => {
      queueRunning.current = false;
      setQueueTick((n) => n + 1);
    });
  }, [w.tasks, w.projects, w.settings, statuses, queueTick]);

  const moveTask = async (id: string, status: TaskStatus) => {
    const task = latest.current.tasks.find((t) => t.id === id);
    if (!task || task.status === status) return;
    if (status === "running") {
      await startTask(id);
      return;
    }
    cancelled.current.add(id);
    if (task.paneId) {
      try {
        await stopSession(task.paneId);
      } catch (e) {
        notify(String(e));
        return;
      }
    }
    patchTask(id, {
      status,
      paneId: undefined,
      queued: false,
      attention: undefined,
      interrupted: false,
      ...(status === "done" && { changeRequest: undefined }),
    });
  };
  const saveTask = (draft: TaskDraft, run: boolean) => {
    const id = composer?.id ?? newId("task");
    const existing = latest.current.tasks.find((t) => t.id === id);
    const task: Task = {
      id,
      status: "backlog",
      projectId: project.id,
      createdAt: Date.now(),
      ...existing,
      // Only the composer-owned fields, so editing a task that changed while
      // the dialog was open cannot revert its live status/pane binding.
      ...draftFromTask(draft),
    };
    const tasks = existing
      ? latest.current.tasks.map((t) => (t.id === id ? task : t))
      : [...latest.current.tasks, task];
    if (hasDependencyCycle(tasks)) {
      notify(
        "These dependencies form a cycle. Remove a dependency before saving.",
      );
      return;
    }
    // Only a new task consumes the recovered draft; editing an existing task
    // must leave a half-written new-task draft alone.
    change((v) => ({
      ...v,
      tasks,
      projects: existing
        ? v.projects
        : v.projects.map((p) =>
            p.id === project.id ? { ...p, draft: undefined } : p,
          ),
    }));
    setComposer(undefined);
    if (run) void startTask(id);
  };
  const archiveTask = async (task: Task) => {
    if (
      !task.archived &&
      latest.current.settings.confirmTaskDelete &&
      isTauri() &&
      !(await confirm(
        `Archive “${task.title}”? You can restore it from the task list.`,
        { title: "Archive task" },
      ))
    )
      return;
    patchTask(task.id, { archived: !task.archived, queued: false });
    setDetail(undefined);
    notify(
      task.archived ? "Task restored" : "Task archived",
      () => patchTask(task.id, { archived: task.archived }),
      "Undo",
    );
  };
  const duplicateTask = (task: Task) => {
    const id = newId("task");
    change((v) => ({
      ...v,
      tasks: [
        ...v.tasks,
        {
          ...task,
          id,
          title: `${task.title} (copy)`,
          status: "backlog",
          paneId: undefined,
          queued: false,
          archived: false,
          worktree: undefined,
          attention: undefined,
          interrupted: false,
          lastExitCode: undefined,
          reviewNotes: "",
          reviewedAt: undefined,
          changeRequest: undefined,
          reviewOf: undefined,
          verdict: undefined,
          messageIds: undefined,
          hop: undefined,
          createdAt: Date.now(),
        },
      ],
    }));
    setDetail(undefined);
    setComposer({ id, key: id });
  };
  const requestReview = async (taskId: string, reviewerId: string) => {
    const before = latest.current;
    const task = before.tasks.find((t) => t.id === taskId);
    if (
      !task ||
      task.paneId ||
      task.status === "running" ||
      reviewing.current.has(taskId)
    )
      return;
    const reviewer = before.agents.find((a) => a.id === reviewerId);
    if (!reviewer || !reviewer.enabled) {
      notify("Choose an available reviewer agent.");
      return;
    }
    reviewing.current.add(taskId);
    try {
      // The builder's latest finished run: it is what the reviewer is looking at.
      const finished = before.usage.filter(
        (r) => r.taskId === taskId && r.outcome !== "running",
      );
      const run: RunRecord | undefined = finished[finished.length - 1];
      // The changed-file list comes from the run's saved snapshot. Losing it is
      // not fatal: the prompt then tells the reviewer to inspect the tree itself.
      let files: ReviewFile[] | undefined;
      if (run && isTauri()) {
        try {
          const data = await invoke<ReviewData>("read_run", {
            runId: run.id,
            refresh: false,
          });
          if (data.review.git)
            files = data.review.files.map(({ path, status }) => ({
              path,
              status,
            }));
        } catch {
          // Non-fatal: `files` stays undefined.
        }
      }
      // State may have moved on while the snapshot was being read.
      const state = latest.current;
      const current = state.tasks.find((t) => t.id === taskId);
      if (!current || current.paneId || current.status === "running") return;
      const builderName =
        state.agents.find((a) => a.id === current.agentId)?.name ??
        run?.agentName ??
        "another agent";
      const prompt = buildReviewPrompt({
        task: current,
        builderName,
        run,
        files,
        instructions: state.settings.reviewInstructions,
      });
      const review = reviewTaskFor(current, run, reviewer.id, prompt, {
        id: newId("task"),
        now: Date.now(),
      });
      change((v) => ({ ...v, tasks: [...v.tasks, review] }));
      notify(
        `Review task created for “${current.title}”.`,
        () => showTask(review.id),
        "Open review",
      );
      void startTask(review.id);
    } finally {
      reviewing.current.delete(taskId);
    }
  };
  const reorderTask = (id: string, direction: number) =>
    change((v) => {
      const tasks = [...v.tasks];
      const index = tasks.findIndex((t) => t.id === id);
      let target = index + direction;
      while (
        target >= 0 &&
        target < tasks.length &&
        (tasks[target].projectId !== project.id || !tasks[target].queued)
      )
        target += direction;
      if (index >= 0 && target >= 0 && target < tasks.length) {
        [tasks[index], tasks[target]] = [tasks[target], tasks[index]];
      }
      return { ...v, tasks };
    });

  const split = (slot: string, direction: "right" | "down") => {
    if (order.length >= MAX_PANES) {
      notify(`This project has reached its ${MAX_PANES}-session limit.`);
      return;
    }
    const id = newId("pane");
    patchProject(project.id, (p) => ({
      ...p,
      layout:
        direction === "right"
          ? splitColumn(p.layout, slot, id, newId("col"))
          : splitPane(p.layout, slot, id),
      slotAgents: {
        ...p.slotAgents,
        [id]: p.preferredAgentId || available[0].id,
      },
      slotNames: {
        ...p.slotNames,
        [id]: `Session ${paneIds(p.layout).length + 1}`,
      },
    }));
    setExpanded(undefined);
  };
  const closePane = (id: string) => {
    if (
      order.length <= 1 ||
      isBusy(sessionState(id)) ||
      reservations.current.has(id)
    )
      return;
    disposeSession(id);
    patchProject(project.id, (p) => ({
      ...p,
      layout: removePane(p.layout, id),
    }));
    if (expanded === id) setExpanded(undefined);
  };
  const preset = (presetId: string) => {
    const target = LAYOUT_PRESETS.find((p) => p.id === presetId);
    if (!target) return;
    const result = applyPreset(
      project.layout,
      target,
      () => newId("pane"),
      () => newId("col"),
    );
    if (
      result.dropped.some(
        (id) => isBusy(sessionState(id)) || reservations.current.has(id),
      )
    ) {
      notify(
        "This layout would close a running session. Stop it first or use focus mode.",
      );
      return;
    }
    result.dropped.forEach(disposeSession);
    patchProject(project.id, (p) => ({
      ...p,
      layout: result.layout,
      slotAgents: {
        ...p.slotAgents,
        ...Object.fromEntries(
          result.added.map((id) => [id, p.preferredAgentId || available[0].id]),
        ),
      },
      slotNames: {
        ...p.slotNames,
        ...Object.fromEntries(
          result.added.map((id, i) => [id, `Session ${order.length + i + 1}`]),
        ),
      },
    }));
    setExpanded(undefined);
  };
  const placement = (e: React.DragEvent): PaneDropPlacement => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (x < 0.2) return "column-before";
    if (x > 0.8) return "column-after";
    return e.clientY - r.top < r.height / 2 ? "before" : "after";
  };
  const drop = (id: string, e: React.DragEvent) => {
    const source = dragSlot;
    if (!source || source === id) return;
    e.preventDefault();
    const where = placement(e);
    patchProject(project.id, (p) => ({
      ...p,
      layout: movePane(p.layout, source, id, where, () => newId("col")),
    }));
    setDragSlot(undefined);
    setDropHint(undefined);
  };
  const move = (id: string, direction: PaneMoveDirection) =>
    patchProject(project.id, (p) => ({
      ...p,
      layout: movePaneStep(p.layout, id, direction, () => newId("col")),
    }));

  const sendBroadcast = async () => {
    const text = broadcast;
    if (!text.trim() || broadcastBusy) return;
    const ids = order.filter(
      (id) => sessionState(id) === "running" && w.targets[id] !== false,
    );
    if (!ids.length) {
      setDelivery("Select at least one running session.");
      return;
    }
    setBroadcastBusy(true);
    const result = await Promise.allSettled(
      ids.map((id) =>
        sendSession(id, text + (w.settings.broadcastAppendEnter ? "\r" : "")),
      ),
    );
    const failed = ids.filter((_, i) => result[i].status === "rejected");
    setDelivery(
      failed.length
        ? `Delivered to ${ids.length - failed.length}/${ids.length}. Failed: ${failed.map(slotTitle).join(", ")}. Draft kept.`
        : `Delivered to ${ids.length} terminal${ids.length === 1 ? "" : "s"}.`,
    );
    if (!failed.length) setBroadcast("");
    else
      change((v) => ({
        ...v,
        targets: {
          ...v.targets,
          ...Object.fromEntries(ids.map((id) => [id, failed.includes(id)])),
        },
      }));
    setBroadcastBusy(false);
  };

  const openProjectDialog = (mode: "new" | "edit") => {
    setProjectDialog(mode);
    setProjectName(mode === "edit" ? project.name : "");
    setProjectPath(mode === "edit" ? project.cwd : "");
    setProjectError("");
  };
  const browseProject = async () => {
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "Open project folder",
      });
      if (typeof path === "string") {
        setProjectPath(path);
        if (!projectName) setProjectName(basename(path));
      }
    } catch (e) {
      setProjectError(String(e));
    }
  };
  const saveProject = async () => {
    if (!projectPath.trim()) return;
    setProjectBusy(true);
    try {
      const info = await invoke<ProjectInfo>("project_info", {
        cwd: projectPath.trim(),
      });
      if (projectDialog === "edit") {
        patchProject(project.id, (p) => ({
          ...p,
          name: projectName.trim() || info.name,
          cwd: info.cwd,
        }));
      } else {
        const existing = latest.current.projects.find(
          (p) => p.cwd.toLowerCase() === info.cwd.toLowerCase(),
        );
        if (existing) switchProject(existing.id);
        else {
          const p = makeProject(
            projectName.trim() || info.name,
            info.cwd,
            available,
          );
          change((v) => ({
            ...v,
            projects: [...v.projects, p],
            activeProjectId: p.id,
          }));
          setExpanded(undefined);
        }
      }
      setProjectDialog(undefined);
      setInfoRefresh((n) => n + 1);
    } catch (e) {
      setProjectError(String(e));
    } finally {
      setProjectBusy(false);
    }
  };

  const replaceWorkspace = async (next: Workspace) => {
    transitioning.current = true;
    operationEpoch.current++;
    try {
      for (const id of launches.current) cancelled.current.add(id);
      await Promise.all(
        latest.current.projects
          .flatMap((p) => paneIds(p.layout))
          .map(stopSession),
      );
      if (isTauri()) await invoke("wait_for_saves");
      for (const id of allSlots) disposeSession(id);
      change(() => next);
      setExpanded(undefined);
      setDetail(undefined);
      setRunDetail(undefined);
      setComposer(undefined);
      setStatuses({});
      setPage("workspace");
      scheduleSave(next);
      await flushSave();
    } finally {
      transitioning.current = false;
    }
  };
  const importWorkspace = async (text: string): Promise<string | undefined> => {
    try {
      const next = parseBackup(text);
      if (
        isTauri() &&
        !(await confirm(
          `Restore ${next.projects.length} project(s) and ${next.tasks.length} task(s)? Current sessions will stop. Credentials must be configured again if this backup was redacted.`,
          { title: "Restore workspace", kind: "warning" },
        ))
      )
        return "Restore cancelled.";
      await replaceWorkspace(next);
      notify("Workspace restored.");
      return undefined;
    } catch (e) {
      transitioning.current = false;
      return String(e);
    }
  };
  const finishClose = async () => {
    if (closeBusy) return;
    setCloseBusy(true);
    try {
      transitioning.current = true;
      operationEpoch.current++;
      for (const id of launches.current) cancelled.current.add(id);
      await Promise.all(
        latest.current.projects
          .flatMap((p) => paneIds(p.layout))
          .map(stopSession),
      );
      // Stopped teammate runs still hand back their memory and messages.
      await Promise.allSettled([...collecting.current]);
      await invoke("wait_for_saves");
      await invoke("save_window_state");
      scheduleSave(latest.current);
      await flushSave();
      await getCurrentWindow().destroy();
    } catch (e) {
      notify(`Could not close safely: ${String(e)}`);
      transitioning.current = false;
      setCloseBusy(false);
    }
  };
  const closeRef = useRef(finishClose);
  closeRef.current = finishClose;
  useEffect(() => {
    if (!isTauri()) return;
    const listener = getCurrentWindow().onCloseRequested((e) => {
      e.preventDefault();
      if (
        latest.current.projects.some((p) =>
          paneIds(p.layout).some((id) => isBusy(sessionState(id))),
        ) ||
        launches.current.size
      )
        setClosing(true);
      else void closeRef.current();
    });
    return () => {
      void listener.then((un) => un());
    };
  }, []);
  const keysRef = useRef({
    newTask,
    toggleFocus: () =>
      setExpanded(expanded ? undefined : activePane || order[0]),
    toggleDashboard,
  });
  keysRef.current = {
    newTask,
    toggleFocus: () =>
      setExpanded(expanded ? undefined : activePane || order[0]),
    toggleDashboard,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (document.querySelector('[role="dialog"]') && key !== "p") return;
      if (!["p", "n", "b", "e", "d"].includes(key)) return;
      e.preventDefault();
      if (key === "p") setPalette((v) => !v);
      if (key === "d") keysRef.current.toggleDashboard();
      if (key === "n") keysRef.current.newTask();
      if (key === "b") setBroadcastOpen((v) => !v);
      if (key === "e") keysRef.current.toggleFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const busyAgents = [
    ...new Set(
      running
        .map((id) => sessionRun(id)?.agentId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const remapAgent = (id: string, remove: boolean) => {
    if (busyAgents.includes(id)) {
      notify("Stop this agent's sessions before changing its availability.");
      return;
    }
    const fallback = available.find((a) => a.id !== id);
    if (!fallback) return;
    change((v) => ({
      ...v,
      agents: remove
        ? v.agents.filter((a) => a.id !== id)
        : v.agents.map((a) => (a.id === id ? { ...a, enabled: false } : a)),
      projects: v.projects.map((p) => ({
        ...p,
        preferredAgentId:
          p.preferredAgentId === id ? fallback.id : p.preferredAgentId,
        slotAgents: Object.fromEntries(
          Object.entries(p.slotAgents).map(([slot, a]) => [
            slot,
            a === id ? fallback.id : a,
          ]),
        ),
      })),
      tasks: v.tasks.map((t) =>
        t.agentId === id ? { ...t, agentId: fallback.id } : t,
      ),
      teammates: v.teammates.map((t) =>
        t.agentId === id ? { ...t, agentId: fallback.id } : t,
      ),
    }));
  };
  const addTeammate = (): string => {
    const taken = new Set(latest.current.teammates.map((t) => t.name));
    let name = "New teammate";
    for (let n = 2; taken.has(name); n++) name = `New teammate ${n}`;
    const mate: Teammate = {
      id: newId("teammate"),
      name,
      agentId: available[0].id,
      brief: "",
      memory: "",
      canMessage: true,
      onMessage: "hold",
      createdAt: Date.now(),
    };
    change((v) => ({ ...v, teammates: [...v.teammates, mate] }));
    return mate.id;
  };
  const updateTeammate = (id: string, patch: Partial<Teammate>) =>
    change((v) => ({
      ...v,
      teammates: v.teammates.map((t) =>
        t.id === id
          ? {
              ...t,
              ...patch,
              ...("memory" in patch && { memoryUpdatedAt: Date.now() }),
            }
          : t,
      ),
    }));
  const deleteTeammate = async (id: string) => {
    const mate = latest.current.teammates.find((t) => t.id === id);
    if (!mate) return;
    if (
      isTauri() &&
      !(await confirm(
        `Delete ${mate.name}, its memory and the messages sent to it? Tasks it was assigned keep their engine.`,
        { title: "Delete teammate", kind: "warning" },
      ))
    )
      return;
    change((v) => ({
      ...v,
      teammates: v.teammates.filter((t) => t.id !== id),
      // Its messages go with it; what it sent stays with the recipients.
      messages: v.messages.filter((m) => m.to !== id),
      tasks: v.tasks.map((t) => {
        if (t.teammateId !== id) return t;
        // A message task that has not run has nobody left to read its inbox.
        const orphan =
          Boolean(t.messageIds) && t.status === "backlog" && !t.paneId;
        return {
          ...t,
          teammateId: undefined,
          archived: t.archived || orphan,
          queued: orphan ? false : t.queued,
        };
      }),
    }));
  };
  const saveAgent = (draft: AgentDraft, id?: string) =>
    change((v) => ({
      ...v,
      agents: id
        ? v.agents.map((a) => (a.id === id ? { ...draft, id } : a))
        : [...v.agents, { ...draft, id: newId("agent") }],
    }));
  const resumeRun = (run: RunRecord, sessionId: string) => {
    const p = w.projects.find((p) => p.id === run.projectId) ?? project;
    const slot = paneIds(p.layout).find(
      (id) =>
        !isBusy(sessionState(id)) &&
        !reservations.current.has(id) &&
        !w.tasks.some((t) => t.paneId === id),
    );
    if (!slot) {
      notify("Free a session in this project before resuming.");
      return;
    }
    switchProject(p.id);
    setDetail(undefined);
    setRunDetail(undefined);
    void startManual(slot, { run, sessionId });
  };
  const actions: PaletteAction[] = [
    {
      id: "new-task",
      label: "New task",
      detail: "Plan work in the current project",
      shortcut: "Ctrl+Shift+N",
      run: newTask,
    },
    {
      id: "open-project",
      label: "Open project folder",
      run: () => openProjectDialog("new"),
    },
    {
      id: "focus",
      label: expanded ? "Restore pane layout" : "Focus current session",
      shortcut: "Ctrl+Shift+E",
      run: () => setExpanded(expanded ? undefined : activePane || order[0]),
    },
    {
      id: "dashboard",
      label: w.dashboardOpen ? "Close dashboard" : "Open dashboard",
      detail: "Every agent, grouped by what it is doing",
      shortcut: "Ctrl+Shift+D",
      run: toggleDashboard,
    },
    {
      id: "broadcast",
      label: "Toggle broadcast composer",
      shortcut: "Ctrl+Shift+B",
      run: () => setBroadcastOpen((v) => !v),
    },
    {
      id: "teammates",
      label: "Open teammates",
      detail: "Saved agents with a brief and their own memory",
      run: () => openTeammate(),
    },
    ...w.teammates.map((t) => ({
      id: t.id,
      label: t.name,
      detail: `Teammate · ${w.agents.find((a) => a.id === t.agentId)?.name ?? "engine missing"}`,
      run: () => openTeammate(t.id),
    })),
    { id: "activity", label: "Open activity", run: () => setPage("activity") },
    { id: "settings", label: "Open settings", run: () => setPage("settings") },
    { id: "agents", label: "Manage agents", run: () => setAgentManager(true) },
    ...w.projects.map((p) => ({
      id: p.id,
      label: p.name,
      detail: `Project · ${p.cwd}`,
      run: () => switchProject(p.id),
    })),
    ...w.projects.flatMap((p) =>
      paneIds(p.layout).map((id) => ({
        id,
        label: p.slotNames[id] || "Session",
        detail: `Session · ${p.name} · ${statuses[id] || "idle"}`,
        run: () => showSession(id),
      })),
    ),
    ...w.tasks.map((t) => ({
      id: t.id,
      label: t.title,
      detail: `Task · ${t.status}${t.archived ? " · archived" : ""}`,
      run: () => showTask(t.id),
    })),
    ...[...w.usage].reverse().map((r) => ({
      id: r.id,
      label: r.taskTitle || r.session,
      detail: `Run · ${r.outcome} · ${new Date(r.startedAt).toLocaleString()}`,
      run: () => openRun(r.id),
    })),
  ];
  // A project switch or restored layout can drop the focused pane. Ignore a
  // stale id rather than hiding every column and blanking the workspace.
  const focused = expanded && order.includes(expanded) ? expanded : undefined;
  const focusColumn = project.layout.find((c) =>
    c.panes.some((p) => p.id === focused),
  )?.id;
  const pct = (a: number, b: number) => Math.round((a / (a + b)) * 100);
  const dashboardRows: DashboardRow[] = w.projects.flatMap((p) =>
    paneIds(p.layout).flatMap((id) => {
      const state = activity[id];
      if (!state) return [];
      const run = sessionRun(id);
      const agent = w.agents.find(
        (a) => a.id === (run?.agentId ?? p.slotAgents[id]),
      );
      return [
        {
          id,
          title: run?.taskTitle || p.slotNames[id] || "Session",
          agent: run?.teammateName ?? agent?.name ?? run?.agentName ?? "Agent",
          accent: agent?.accent ?? "var(--text-dim)",
          project: p.name,
          activity: state,
        },
      ];
    }),
  );
  const waitingCount = dashboardRows.filter(
    (r) => r.activity.activity === "waiting",
  ).length;
  const inboxCount = w.teammates.reduce(
    (n, t) => n + waitingFor(w.messages, t.id),
    0,
  );

  return (
    <div className="app premium-app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <CrucibleIcon width={21} />
          </span>
          Crucible
        </div>
        <div className="project-switcher">
          <FolderIcon />
          <select
            aria-label="Current project"
            value={project.id}
            onChange={(e) => switchProject(e.target.value)}
          >
            {[...w.projects]
              .sort((a, b) => b.lastOpened - a.lastOpened)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {paneIds(p.layout).some((id) => isBusy(statuses[id]))
                    ? " · live"
                    : ""}
                </option>
              ))}
          </select>
          <button
            className="icon-button"
            aria-label="Open project"
            title="Open project folder"
            onClick={() => openProjectDialog("new")}
          >
            <PlusIcon />
          </button>
        </div>
        <nav className="main-nav" aria-label="Pages">
          {(["workspace", "teammates", "activity", "settings"] as const).map(
            (p) => (
              <button
                key={p}
                className={page === p ? "selected" : ""}
                aria-current={page === p ? "page" : undefined}
                onClick={() => setPage(p)}
              >
                {p === "workspace" ? (
                  <TerminalIcon />
                ) : p === "teammates" ? (
                  <TeammatesIcon />
                ) : p === "activity" ? (
                  <ActivityIcon />
                ) : (
                  <SettingsIcon />
                )}
                {p[0].toUpperCase() + p.slice(1)}
                {p === "teammates" && inboxCount > 0 && (
                  <b
                    className="count-badge"
                    title={`${inboxCount} message${inboxCount === 1 ? "" : "s"} waiting for teammates`}
                  >
                    {inboxCount}
                    <span className="sr-only"> waiting</span>
                  </b>
                )}
              </button>
            ),
          )}
        </nav>
        <span className="spacer" />
        <button
          className="command-trigger"
          onClick={() => setPalette(true)}
          aria-label="Search commands, projects, tasks, and runs"
        >
          <SearchIcon />
          <span>Search</span>
          <kbd>Ctrl Shift P</kbd>
        </button>
        <button
          className="dashboard-toggle"
          onClick={toggleDashboard}
          aria-pressed={page === "workspace" && w.dashboardOpen}
          aria-controls="dashboard-panel"
          aria-label={`Dashboard${waitingCount ? `, ${waitingCount} need you` : ""}`}
          title="Dashboard (Ctrl+Shift+D)"
        >
          <DashboardIcon />
          {waitingCount > 0 && <b>{waitingCount}</b>}
          <span>Dashboard</span>
        </button>
        <button
          ref={attentionTrigger}
          className={`attention-button ${attention.length ? "has-attention" : ""}`}
          onClick={() => setAttentionOpen(!attentionOpen)}
          aria-expanded={attentionOpen}
          aria-haspopup="dialog"
          aria-controls="attention-panel"
        >
          <ActivityIcon />
          {attention.length}
          <span>Need attention</span>
        </button>
      </header>
      {saveError && (
        <div className="save-error" role="alert">
          Changes could not be saved: {saveError}
          <button
            className="text-button"
            onClick={() => {
              scheduleSave(w);
              void flushSave().catch(() => {});
            }}
          >
            Retry save
          </button>
          <button className="text-button" onClick={() => setPage("settings")}>
            Backup options
          </button>
        </div>
      )}
      {attentionOpen && (
        <aside
          ref={attentionRef}
          className="attention-panel"
          id="attention-panel"
          aria-labelledby="attention-heading"
        >
          <header>
            <h2 id="attention-heading">Needs attention</h2>
            <button
              className="icon-button"
              aria-label="Close attention list"
              onClick={closeAttention}
            >
              <CloseIcon />
            </button>
          </header>
          {attention.length ? (
            attention.map((t) => (
              <button key={t.id} onClick={() => showTask(t.id)}>
                <strong>{t.title}</strong>
                <small>
                  {w.projects.find((p) => p.id === t.projectId)?.name} ·{" "}
                  {t.attention || t.status}
                </small>
              </button>
            ))
          ) : (
            <p className="empty-small">
              All caught up. Finished runs and agent requests appear here.
            </p>
          )}
        </aside>
      )}
      {page === "workspace" && (
        <>
          <div className="workspace-toolbar">
            <button
              className="project-context"
              onClick={() => openProjectDialog("edit")}
              title={project.cwd || "Choose project folder"}
            >
              <FolderIcon />
              <strong>{project.name}</strong>
              <span>
                {projectInfo?.gitError
                  ? "Git unavailable"
                  : projectInfo?.branch}
                {projectInfo?.dirty ? " · uncommitted changes" : ""}
              </span>
            </button>
            <span className="spacer" />
            <span className="live-summary">
              {projectRunning.length} live
              {running.length > projectRunning.length
                ? ` · ${running.length - projectRunning.length} in other projects`
                : ""}
            </span>
            <select
              className="layout-picker"
              aria-label="Pane layout"
              value=""
              onChange={(e) => {
                if (e.target.value === "save")
                  patchProject(project.id, (p) => ({
                    ...p,
                    savedLayout: p.layout,
                  }));
                else if (e.target.value === "restore" && project.savedLayout) {
                  const ids = new Set(paneIds(project.savedLayout));
                  const dropped = order.filter((id) => !ids.has(id));
                  if (
                    dropped.some(
                      (id) =>
                        isBusy(sessionState(id)) ||
                        reservations.current.has(id),
                    )
                  )
                    notify(
                      "This layout would close a running session. Stop it first or use focus mode.",
                    );
                  else {
                    dropped.forEach(disposeSession);
                    patchProject(project.id, (p) => ({
                      ...p,
                      layout: p.savedLayout!,
                    }));
                    setExpanded(undefined);
                  }
                } else preset(e.target.value);
              }}
            >
              <option value="" disabled>
                Layout
              </option>
              {LAYOUT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="save">Save this layout</option>
              {project.savedLayout && (
                <option value="restore">Restore saved layout</option>
              )}
            </select>
            <button
              className="btn"
              onClick={() =>
                order
                  .filter((id) => !isBusy(sessionState(id)))
                  .forEach((id) => void startManual(id))
              }
              disabled={projectRunning.length === order.length}
            >
              <PlayIcon />
              Start idle
            </button>
            <button
              className="icon-button"
              disabled={!running.length}
              aria-label="Stop all sessions"
              title="Stop all sessions"
              onClick={() => void stopAll()}
            >
              <StopIcon />
            </button>
            <button className="btn primary" onClick={newTask}>
              <PlusIcon />
              New task
            </button>
          </div>
          {(!project.cwd || infoError || projectInfo?.gitError) && (
            <div className="onboarding-strip">
              <FolderIcon />
              <span>
                {infoError ||
                  projectInfo?.gitError ||
                  "Choose a folder to give your agents a project to work in."}
              </span>
              {projectInfo?.gitError ? (
                <button
                  className="btn"
                  onClick={() => setInfoRefresh((n) => n + 1)}
                >
                  Check again
                </button>
              ) : null}
              <button className="btn" onClick={() => openProjectDialog("edit")}>
                Choose project folder
              </button>
              <button
                className="text-button"
                onClick={() => setPage("settings")}
              >
                Check agent setup
              </button>
            </div>
          )}
          {focused && (
            <div className="focus-strip">
              <span>Focused · {slotTitle(focused)}</span>
              <span className="spacer" />
              <button
                className="text-button"
                onClick={() => setExpanded(undefined)}
              >
                Restore layout <kbd>Ctrl Shift E</kbd>
              </button>
            </div>
          )}
          <div
            className="main-row"
            style={
              {
                "--board-width": `${Math.min(w.boardWidth, railMax)}px`,
                "--dashboard-width": `${DASHBOARD_WIDTH}px`,
              } as React.CSSProperties
            }
          >
            <TaskBoard
              tasks={currentTasks}
              allTasks={w.tasks}
              agents={w.agents}
              teammates={w.teammates}
              collapsed={w.boardCollapsed}
              onCollapse={() =>
                change((v) => ({ ...v, boardCollapsed: !v.boardCollapsed }))
              }
              onNew={newTask}
              onOpen={showTask}
              onRun={(id) => void startTask(id)}
              onMove={(id, status) => void moveTask(id, status)}
              onCancelQueue={(id) => patchTask(id, { queued: false })}
              onReorder={reorderTask}
            />
            {!w.boardCollapsed && (
              <div
                className="rail-resizer"
                role="separator"
                aria-label="Resize task sidebar"
                aria-orientation="vertical"
                aria-valuenow={Math.min(w.boardWidth, railMax)}
                aria-valuemin={240}
                aria-valuemax={railMax}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                    e.preventDefault();
                    change((v) => ({
                      ...v,
                      boardWidth: clampRail(
                        v.boardWidth + (e.key === "ArrowRight" ? 16 : -16),
                      ),
                    }));
                  }
                }}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    change((v) => ({
                      ...v,
                      boardWidth: clampRail(e.clientX),
                    }));
                }}
                onPointerUp={(e) =>
                  e.currentTarget.releasePointerCapture(e.pointerId)
                }
              />
            )}
            <main className="workspace">
              {project.layout.map((col, ci) => (
                <Fragment key={col.id}>
                  {ci > 0 && !focused && (
                    <SplitDivider
                      orientation="col"
                      label={`Resize column ${ci}`}
                      valueNow={pct(project.layout[ci - 1].size, col.size)}
                      onResize={(sizes) =>
                        patchProject(project.id, (p) => ({
                          ...p,
                          layout: withColumnSizes(p.layout, sizes),
                        }))
                      }
                    />
                  )}
                  <div
                    className="ws-col"
                    style={
                      {
                        "--col-size": col.size,
                        display:
                          focused && focusColumn !== col.id
                            ? "none"
                            : undefined,
                      } as React.CSSProperties
                    }
                  >
                    {col.panes.map((pane, pi) => {
                      const a =
                        available.find(
                          (a) => a.id === project.slotAgents[pane.id],
                        ) ?? available[0];
                      const bound = w.tasks.find((t) => t.paneId === pane.id);
                      const liveRun = sessionRun(pane.id);
                      const effective = isBusy(statuses[pane.id])
                        ? liveRun?.cwd || project.cwd
                        : project.slotCwds[pane.id] || project.cwd;
                      return (
                        <Fragment key={pane.id}>
                          {pi > 0 && !focused && (
                            <SplitDivider
                              orientation="row"
                              label={`Resize row ${pi}`}
                              valueNow={pct(col.panes[pi - 1].size, pane.size)}
                              onResize={(sizes) =>
                                patchProject(project.id, (p) => ({
                                  ...p,
                                  layout: withPaneSizes(
                                    p.layout,
                                    col.id,
                                    sizes,
                                  ),
                                }))
                              }
                            />
                          )}
                          <div
                            className="pane-mount"
                            style={{
                              flex: `${pane.size} 1 0%`,
                              display:
                                focused && focused !== pane.id
                                  ? "none"
                                  : undefined,
                            }}
                          >
                            <AgentPane
                              id={pane.id}
                              title={project.slotNames[pane.id] || "Session"}
                              agent={a}
                              agents={available}
                              cwd={effective}
                              settings={w.settings}
                              taskTitle={bound?.title}
                              size={pane.size}
                              expanded={focused === pane.id}
                              active={activePane === pane.id}
                              activity={activity[pane.id]}
                              flash={
                                flash?.id === pane.id ? flash.n : undefined
                              }
                              canClose={order.length > 1}
                              canSplit={order.length < MAX_PANES}
                              blocked={
                                launchBlockReason(a, w.settings) ||
                                (!project.cwd && !project.slotCwds[pane.id]
                                  ? "Choose a project folder to start."
                                  : undefined)
                              }
                              dropHint={
                                dropHint?.id === pane.id
                                  ? dropHint.placement
                                  : undefined
                              }
                              onStart={() => void startManual(pane.id)}
                              onStop={() => void stop(pane.id)}
                              onExpand={() =>
                                setExpanded(
                                  expanded === pane.id ? undefined : pane.id,
                                )
                              }
                              onActive={() => {
                                setActivePane(pane.id);
                                markSeen(pane.id);
                              }}
                              onAgent={(id) =>
                                patchProject(project.id, (p) => ({
                                  ...p,
                                  slotAgents: {
                                    ...p.slotAgents,
                                    [pane.id]: id,
                                  },
                                }))
                              }
                              onRename={(title) =>
                                patchProject(project.id, (p) => ({
                                  ...p,
                                  slotNames: {
                                    ...p.slotNames,
                                    [pane.id]: title,
                                  },
                                }))
                              }
                              onCwd={(cwd) =>
                                patchProject(project.id, (p) => {
                                  const slotCwds = { ...p.slotCwds };
                                  if (cwd) slotCwds[pane.id] = cwd;
                                  else delete slotCwds[pane.id];
                                  return { ...p, slotCwds };
                                })
                              }
                              onClose={() => closePane(pane.id)}
                              onSplit={(d) => split(pane.id, d)}
                              onMove={(d) => move(pane.id, d)}
                              onDragStart={(e) => {
                                setDragSlot(pane.id);
                                e.dataTransfer.setData(
                                  "application/x-crucible-pane",
                                  pane.id,
                                );
                                e.dataTransfer.effectAllowed = "move";
                              }}
                              onDragOver={(e) => {
                                if (dragSlot && dragSlot !== pane.id) {
                                  e.preventDefault();
                                  setDropHint({
                                    id: pane.id,
                                    placement: placement(e),
                                  });
                                }
                              }}
                              onDrop={(e) => drop(pane.id, e)}
                              onDragEnd={() => {
                                setDragSlot(undefined);
                                setDropHint(undefined);
                              }}
                            />
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                </Fragment>
              ))}
            </main>
            {w.dashboardOpen && (
              <Dashboard
                floating={!dashboardDocked}
                rows={dashboardRows}
                onOpen={openPane}
                onClose={() => change((v) => ({ ...v, dashboardOpen: false }))}
              />
            )}
          </div>
          <footer
            className={`desktop-statusbar ${broadcastOpen ? "expanded" : ""}`}
          >
            <div className="statusbar-line">
              <button
                className="text-button"
                onClick={() => setBroadcastOpen(!broadcastOpen)}
                aria-expanded={broadcastOpen}
              >
                <BroadcastIcon />
                Broadcast <kbd>Ctrl Shift B</kbd>
              </button>
              <span>
                {
                  order.filter(
                    (id) =>
                      statuses[id] === "running" && w.targets[id] !== false,
                  ).length
                }{" "}
                running recipients
              </span>
              <span className="spacer" />
              <span>
                {saveError
                  ? "Save needs attention"
                  : !isTauri()
                    ? "Desktop preview"
                    : saving
                      ? "Saving…"
                      : "Saved on this device"}
              </span>
              <button
                className="text-button"
                onClick={() => setAgentManager(true)}
              >
                <BotIcon />
                Agents
              </button>
            </div>
            {broadcastOpen && (
              <div className="broadcast-composer">
                <div className="broadcast-recipient-row">
                  {order.map((id) => (
                    <button
                      key={id}
                      className={`chip ${w.targets[id] !== false ? "selected" : ""}`}
                      disabled={statuses[id] !== "running"}
                      aria-pressed={w.targets[id] !== false}
                      onClick={() =>
                        change((v) => ({
                          ...v,
                          targets: {
                            ...v.targets,
                            [id]: v.targets[id] === false,
                          },
                        }))
                      }
                    >
                      {slotTitle(id)}
                      {statuses[id] !== "running" ? " · offline" : ""}
                    </button>
                  ))}
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={w.settings.broadcastAppendEnter}
                      onChange={(e) =>
                        change((v) => ({
                          ...v,
                          settings: {
                            ...v.settings,
                            broadcastAppendEnter: e.target.checked,
                          },
                        }))
                      }
                    />
                    Submit with Enter
                  </label>
                </div>
                <div className="broadcast-compose-row">
                  <textarea
                    aria-label="Broadcast message"
                    rows={2}
                    placeholder="Message selected running sessions…"
                    value={broadcast}
                    onChange={(e) => {
                      setBroadcast(e.target.value);
                      // The previous result describes the previous message.
                      if (delivery) setDelivery(undefined);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void sendBroadcast();
                      }
                    }}
                  />
                  <button
                    className="btn primary"
                    disabled={broadcastBusy || !broadcast.trim()}
                    onClick={() => void sendBroadcast()}
                  >
                    <SendIcon />
                    {broadcastBusy ? "Sending…" : "Send"}
                  </button>
                </div>
                {delivery && (
                  <p className="delivery-result" role="status">
                    {delivery}
                  </p>
                )}
              </div>
            )}
          </footer>
        </>
      )}
      <Suspense fallback={<p className="empty-small">Opening page…</p>}>
        {page === "teammates" && (
          <TeammatesPage
            teammates={w.teammates}
            agents={w.agents}
            tasks={w.tasks}
            runs={w.usage}
            messages={w.messages}
            projects={w.projects}
            focus={teammateFocus}
            onAdd={addTeammate}
            onUpdate={updateTeammate}
            onDelete={(id) => void deleteTeammate(id)}
            onOpenTask={showTask}
            onSend={sendOwnerMessage}
            onStartMessage={startFromMessage}
            onDeleteMessage={deleteMessage}
          />
        )}
        {page === "activity" && (
          <UsagePage
            runs={w.usage}
            agents={w.agents}
            projects={w.projects}
            onOpen={openRun}
          />
        )}{" "}
        {page === "settings" && (
          <SettingsPage
            settings={w.settings}
            onChange={(patch) =>
              change((v) => ({
                ...v,
                settings: { ...v.settings, ...patch },
                usage: retainRuns(
                  v.usage,
                  patch.usageLimit ?? v.settings.usageLimit,
                ),
              }))
            }
            agents={w.agents}
            busyAgentIds={busyAgents}
            onToggleAgent={(id, on) =>
              on
                ? change((v) => ({
                    ...v,
                    agents: v.agents.map((a) =>
                      a.id === id ? { ...a, enabled: true } : a,
                    ),
                  }))
                : remapAgent(id, false)
            }
            onManageAgents={() => setAgentManager(true)}
            runCount={w.usage.length}
            onClearUsage={() =>
              change((v) => ({
                ...v,
                usage: v.usage.filter((r) => r.outcome === "running"),
              }))
            }
            exportWorkspace={() => JSON.stringify(redactWorkspace(w), null, 2)}
            onImportWorkspace={importWorkspace}
            onResetWorkspace={() => {
              void (async () => {
                try {
                  await replaceWorkspace(normalizeWorkspace({}));
                  notify(
                    "Workspace reset. The previous snapshot is retained for recovery.",
                  );
                } catch (e) {
                  notify(String(e));
                }
              })();
            }}
          />
        )}
      </Suspense>
      {agentManager && (
        <AgentManager
          agents={w.agents}
          busyAgentIds={busyAgents}
          openRouter={w.settings.openRouter}
          onAdd={(draft) => saveAgent(draft)}
          onUpdate={(id, draft) => saveAgent(draft, id)}
          onDelete={(id) => remapAgent(id, true)}
          onClose={() => setAgentManager(false)}
        />
      )}
      {composer && (
        <TaskComposer
          key={composer.key}
          task={w.tasks.find((t) => t.id === composer.id)}
          agents={available}
          teammates={w.teammates}
          cwd={
            (
              w.projects.find(
                (p) =>
                  p.id === w.tasks.find((t) => t.id === composer.id)?.projectId,
              ) ?? project
            ).cwd
          }
          tasks={w.tasks.filter(
            (t) =>
              t.projectId ===
              (w.tasks.find((t) => t.id === composer.id)?.projectId ??
                project.id),
          )}
          templates={w.templates}
          initialDraft={project.draft}
          onDraft={(draft) =>
            patchProject(project.id, (p) => ({ ...p, draft }))
          }
          onSave={saveTask}
          onClose={() => setComposer(undefined)}
          onTemplate={(name, draft) => {
            change((v) => ({
              ...v,
              templates: [
                ...v.templates,
                { id: newId("template"), name, draft },
              ],
            }));
            notify("Template saved.");
          }}
        />
      )}
      {selectedTask && !composer && (
        <TaskDetail
          key={selectedTask.id}
          task={selectedTask}
          tasks={w.tasks}
          runs={w.usage.filter((r) => r.taskId === selectedTask.id)}
          onClose={() => setDetail(undefined)}
          onEdit={() =>
            setComposer({ id: selectedTask.id, key: newId("edit") })
          }
          onRun={() => void startTask(selectedTask.id)}
          agents={available}
          reviews={reviewsOf(w.tasks, selectedTask.id)}
          reviewedTask={
            selectedTask.reviewOf
              ? w.tasks.find((t) => t.id === selectedTask.reviewOf)
              : undefined
          }
          onReview={() =>
            patchTask(selectedTask.id, {
              status: "done",
              attention: undefined,
              reviewedAt: Date.now(),
              interrupted: false,
              changeRequest: undefined,
            })
          }
          onRequestReview={(agentId) =>
            void requestReview(selectedTask.id, agentId)
          }
          onRequestChanges={(feedback, rerun) => {
            patchTask(selectedTask.id, {
              changeRequest: feedback.trim() || undefined,
              attention: "Changes requested",
              status: "backlog",
              reviewedAt: undefined,
              interrupted: false,
            });
            if (rerun) void startTask(selectedTask.id);
          }}
          onOpenTask={showTask}
          teammate={w.teammates.find((t) => t.id === selectedTask.teammateId)}
          teammates={w.teammates}
          messages={w.messages.filter((m) =>
            selectedTask.messageIds?.includes(m.id),
          )}
          onOpenTeammate={(id) => openTeammate(id)}
          onArchive={() => archiveTask(selectedTask)}
          onDuplicate={() => duplicateTask(selectedTask)}
          onFocus={() =>
            selectedTask.paneId && showSession(selectedTask.paneId)
          }
          onUpdate={(patch) => patchTask(selectedTask.id, patch)}
          onRunUpdate={(id, patch) =>
            change((v) => ({
              ...v,
              usage: v.usage.map((r) => (r.id === id ? { ...r, ...patch } : r)),
            }))
          }
          onResume={resumeRun}
        />
      )}
      {selectedRun && (
        <Modal
          title={selectedRun.taskTitle || selectedRun.session}
          onClose={() => setRunDetail(undefined)}
          wide
        >
          <div className="detail-body">
            <RunReview
              key={selectedRun.id}
              run={selectedRun}
              onRerun={
                selectedRun.taskId
                  ? () => {
                      setRunDetail(undefined);
                      void startTask(selectedRun.taskId!);
                    }
                  : undefined
              }
              onResume={
                selectedRun.program === "codex" ||
                selectedRun.program === "claude"
                  ? (id) => resumeRun(selectedRun, id)
                  : undefined
              }
              onUpdate={(patch) =>
                change((v) => ({
                  ...v,
                  usage: v.usage.map((r) =>
                    r.id === selectedRun.id ? { ...r, ...patch } : r,
                  ),
                }))
              }
            />
          </div>
        </Modal>
      )}
      {palette && (
        <CommandPalette actions={actions} onClose={() => setPalette(false)} />
      )}
      {projectDialog && (
        <Modal
          title={
            projectDialog === "new" ? "Open a project" : "Project settings"
          }
          onClose={() => {
            if (!projectBusy) setProjectDialog(undefined);
          }}
        >
          <form
            className="project-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveProject();
            }}
          >
            <label>
              Project name
              <input
                autoFocus
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="My project"
              />
            </label>
            <label>
              Folder
              <div className="folder-input">
                <input
                  value={projectPath}
                  onChange={(e) => setProjectPath(e.target.value)}
                  placeholder="C:\Projects\my-project"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => void browseProject()}
                >
                  <FolderIcon />
                  Browse
                </button>
              </div>
            </label>
            {projectDialog === "edit" && (
              <label>
                Preferred agent for new sessions
                <select
                  value={project.preferredAgentId || available[0].id}
                  onChange={(e) =>
                    patchProject(project.id, (p) => ({
                      ...p,
                      preferredAgentId: e.target.value,
                    }))
                  }
                >
                  {available.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="muted">
              Each project keeps its tasks, sessions, and layout. Agents in
              other projects continue running when you switch.
            </p>
            {projectError && (
              <p className="error-text" role="alert">
                {projectError}
              </p>
            )}
            <footer className="dialog-actions">
              <button
                className="btn"
                type="button"
                onClick={() => setProjectDialog(undefined)}
                disabled={projectBusy}
              >
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={projectBusy || !projectPath.trim()}
              >
                {projectBusy
                  ? "Opening…"
                  : projectDialog === "edit"
                    ? "Save project"
                    : "Open project"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {closing && (
        <Modal
          title="Close Crucible?"
          onClose={() => {
            if (!closeBusy) setClosing(false);
          }}
        >
          <div className="detail-body">
            <p>
              {running.length} session(s) are active. Closing stops their
              processes. Saved output and tasks remain available when you
              return.
            </p>
            <footer className="dialog-actions">
              <button
                className="btn"
                disabled={closeBusy}
                onClick={() => setClosing(false)}
              >
                Keep working
              </button>
              <button
                className="btn primary"
                disabled={closeBusy}
                onClick={() => void finishClose()}
              >
                {closeBusy ? "Saving & stopping…" : "Save, stop & close"}
              </button>
            </footer>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.action && (
            <button
              className="text-button"
              onClick={() => {
                toast.action?.();
                setToast(undefined);
              }}
            >
              {toast.label || "Open"}
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(undefined)}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}
