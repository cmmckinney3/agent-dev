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
import {
  AgentDraft,
  enabledAgents,
  launchBlockReason,
  launchEnv,
  PROMPT_TOKEN,
  resolveTokens,
  seedArgs,
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
  ReviewFile,
  reviewsOf,
  reviewTaskFor,
} from "./review";
import { RunRecord } from "./usage";
import {
  AgentStatus,
  disposeSession,
  focusSession,
  isBusy,
  sendSession,
  sessionRun,
  sessionState,
  startSession,
  stopSession,
  subscribeSessions,
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
  FolderIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  StopIcon,
  TerminalIcon,
  CloseIcon,
} from "./icons";
import "./App.css";
import "./Premium.css";
const UsagePage = lazy(() => import("./UsagePage"));
const SettingsPage = lazy(() => import("./SettingsPage"));
type Page = "workspace" | "activity" | "settings";
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
  const [activePane, setActivePane] = useState("");
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
  const railMax = Math.max(240, Math.min(480, viewport - 560));
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
        }
      }),
    [],
  );

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
    };
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
    const args = resume
      ? a.program === "codex"
        ? ["resume", resume.sessionId]
        : ["--resume", resume.sessionId]
      : a.interactiveArgs
          .filter((arg) => !arg.includes(PROMPT_TOKEN))
          .map((arg) => resolveTokens(arg, a, state.settings));
    patchProject(p.id, (value) => ({
      ...value,
      slotAgents: { ...value.slotAgents, [slot]: a.id },
    }));
    recordRun(run);
    await startSession(
      slot,
      { program: a.program, cwd, args, env: launchEnv(a, state.settings), run },
      state.settings,
    );
  };

  const startTask = async (id: string) => {
    if (transitioning.current || launches.current.has(id)) return;
    const state = latest.current;
    const task = state.tasks.find((t) => t.id === id);
    if (!task || task.archived || task.paneId) return;
    const p = state.projects.find((p) => p.id === task.projectId);
    const a = state.agents.find((a) => a.id === task.agentId);
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
      const run = createRun(slot, a.id, cwd, task);
      recordRun(run);
      patchProject(p.id, (value) => ({
        ...value,
        slotAgents: { ...value.slotAgents, [slot]: a.id },
      }));
      await startSession(
        slot,
        {
          program: a.program,
          cwd,
          args: seedArgs(a, launchPrompt(task), task.mode, state.settings),
          env: launchEnv(a, state.settings),
          run,
        },
        state.settings,
      );
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
  });
  keysRef.current = {
    newTask,
    toggleFocus: () =>
      setExpanded(expanded ? undefined : activePane || order[0]),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (document.querySelector('[role="dialog"]') && key !== "p") return;
      if (!["p", "n", "b", "e"].includes(key)) return;
      e.preventDefault();
      if (key === "p") setPalette((v) => !v);
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
      id: "broadcast",
      label: "Toggle broadcast composer",
      shortcut: "Ctrl+Shift+B",
      run: () => setBroadcastOpen((v) => !v),
    },
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
          {(["workspace", "activity", "settings"] as const).map((p) => (
            <button
              key={p}
              className={page === p ? "selected" : ""}
              aria-current={page === p ? "page" : undefined}
              onClick={() => setPage(p)}
            >
              {p === "workspace" ? (
                <TerminalIcon />
              ) : p === "activity" ? (
                <ActivityIcon />
              ) : (
                <SettingsIcon />
              )}
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
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
              } as React.CSSProperties
            }
          >
            <TaskBoard
              tasks={currentTasks}
              allTasks={w.tasks}
              agents={w.agents}
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
                              onActive={() => setActivePane(pane.id)}
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
