import { AgentConfig, normalizeAgents } from "./agents";
import {
  PaneColumn,
  layoutFromLegacy,
  normalizeLayout,
  paneIds,
} from "./layout";
import { Settings, normalizeSettings } from "./settings";
import { Task, TaskDraft } from "./tasks";
import { RunRecord, normalizeRuns } from "./usage";

export const STORAGE_KEY = "agentdev.workspace.v7";
export const LEGACY_KEYS = [
  STORAGE_KEY,
  ...[6, 5, 4, 3, 2, 1].map((n) => `agentdev.workspace.v${n}`),
];
export interface Project {
  id: string;
  name: string;
  cwd: string;
  lastOpened: number;
  layout: PaneColumn[];
  slotAgents: Record<string, string>;
  slotNames: Record<string, string>;
  slotCwds: Record<string, string>;
  savedLayout?: PaneColumn[];
  preferredAgentId?: string;
  draft?: TaskDraft;
}
export interface PromptTemplate {
  id: string;
  name: string;
  draft: TaskDraft;
}
export interface Workspace {
  version: 7;
  projects: Project[];
  activeProjectId: string;
  agents: AgentConfig[];
  tasks: Task[];
  usage: RunRecord[];
  settings: Settings;
  targets: Record<string, boolean>;
  boardCollapsed: boolean;
  boardWidth: number;
  templates: PromptTemplate[];
}
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown, fallback = "") =>
  typeof v === "string" ? v : fallback;
const finite = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const stringMap = (v: unknown) =>
  Object.fromEntries(
    Object.entries(object(v)).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() || path;

export function makeProject(
  name: string,
  cwd: string,
  agents: AgentConfig[],
): Project {
  const layout = layoutFromLegacy("main-stack").map((c) => ({
    ...c,
    id: newId("col"),
    panes: c.panes.map((p) => ({ ...p, id: newId("pane") })),
  }));
  const enabled = agents.filter((a) => a.enabled);
  return {
    id: newId("project"),
    name,
    cwd,
    lastOpened: Date.now(),
    layout,
    slotAgents: Object.fromEntries(
      paneIds(layout).map((id, i) => [id, enabled[i % enabled.length].id]),
    ),
    slotNames: Object.fromEntries(
      paneIds(layout).map((id, i) => [id, `Session ${i + 1}`]),
    ),
    slotCwds: {},
  };
}

/** Validate untrusted disk/backup data before touching live sessions or stored state. */
export function normalizeWorkspace(raw: unknown, strict = false): Workspace {
  const r = object(raw);
  if (strict) {
    if (
      !Object.keys(r).length ||
      (!("projects" in r) && !("layout" in r) && !("agents" in r))
    )
      throw new Error("Choose a Crucible workspace backup.");
    for (const field of ["projects", "tasks", "agents", "usage", "templates"]) {
      if (r[field] !== undefined && !Array.isArray(r[field]))
        throw new Error(`Backup field “${field}” must be a list.`);
    }
    if (finite(r.version, 7) > 7)
      throw new Error("This backup was made by a newer version of Crucible.");
    if (r.projects !== undefined && (!Array.isArray(r.projects) || !r.projects.length || r.projects.some(p=>!p||typeof p!=="object"))) throw new Error("The backup must contain valid projects.");
    if (
      Array.isArray(r.tasks) &&
      r.tasks.some(
        (t) =>
          !t ||
          typeof t !== "object" ||
          typeof t.title !== "string" ||
          typeof t.prompt !== "string",
      )
    )
      throw new Error("The backup contains an invalid task.");
    if (Array.isArray(r.tasks)) {
      const ids=new Set(r.tasks.map(t=>t.id));
      if(r.tasks.some(t=>t.dependencies!==undefined&&(!Array.isArray(t.dependencies)||t.dependencies.some((id:unknown)=>typeof id!=="string"||!ids.has(id))))) throw new Error("The backup contains invalid task dependencies.");
      if(hasDependencyCycle(r.tasks as Task[])) throw new Error("The backup contains circular task dependencies.");
    }
  }
  const agents = normalizeAgents(r.agents);
  const available = agents.filter((a) => a.enabled);
  const agentId = (id: unknown) =>
    available.some((a) => a.id === id) ? (id as string) : available[0].id;
  const rawProjects =
    Array.isArray(r.projects) && r.projects.length
      ? r.projects
      : [
          {
            ...r,
            id: "project-migrated",
            name: basename(str(r.cwd)) || "My workspace",
          },
        ];
  const seenProjects = new Set<string>();
  const seenPanes = new Set<string>();
  const projects: Project[] = rawProjects.map((value, index) => {
    const p = object(value);
    let id = str(p.id, `project-${index}`);
    if (seenProjects.has(id)) {
      if (strict) throw new Error("Duplicate project IDs in backup.");
      id = newId("project");
    }
    seenProjects.add(id);
    const layout =
      normalizeLayout(p.layout) ?? layoutFromLegacy(p.layoutPreset);
    if (strict && p.layout !== undefined && !normalizeLayout(p.layout))
      throw new Error("The backup contains an invalid pane layout.");
    const slotAgents: Record<string, string> = {};
    const slotNames: Record<string, string> = {};
    const slotCwds: Record<string, string> = {};
    const oldAgents = stringMap(p.slotAgents);
    const oldNames = stringMap(p.slotNames);
    const oldCwds = stringMap(p.slotCwds);
    const paneRemap = new Map<string,string>();
    let i = 0;
    for (const col of layout)
      for (const pane of col.panes) {
        const original = pane.id;
        if (seenPanes.has(pane.id)) pane.id = newId("pane");
        seenPanes.add(pane.id);
        paneRemap.set(original,pane.id);
        i++;
        slotAgents[pane.id] = agentId(oldAgents[original]);
        slotNames[pane.id] = oldNames[original] || `Session ${i}`;
        if (oldCwds[original]) slotCwds[pane.id] = oldCwds[original];
      }
    const savedLayout=normalizeLayout(p.savedLayout)??undefined;
    for(const col of savedLayout??[]) for(const pane of col.panes) {
      const original=pane.id;
      pane.id=paneRemap.get(original)??(seenPanes.has(original)?newId("pane"):original);
      seenPanes.add(pane.id);
      slotAgents[pane.id]??=agentId(oldAgents[original]);
      slotNames[pane.id]??=oldNames[original]||`Session ${++i}`;
      if(oldCwds[original])slotCwds[pane.id]=oldCwds[original];
    }
    return {
      id,
      name: str(p.name).trim() || "Untitled project",
      cwd: str(p.cwd),
      lastOpened: finite(p.lastOpened, 0),
      layout,
      slotAgents,
      slotNames,
      slotCwds,
      savedLayout,
      draft: typeof object(p.draft).prompt === "string" ? {
        title: str(object(p.draft).title), prompt: str(object(p.draft).prompt),
        agentId: agentId(object(p.draft).agentId), mode: object(p.draft).mode === "headless" ? "headless" : "interactive",
        cwd: str(object(p.draft).cwd) || undefined,
        priority: object(p.draft).priority === "high" ? "high" : object(p.draft).priority === "low" ? "low" : "normal",
        isolation: object(p.draft).isolation === true,
        dependencies: Array.isArray(object(p.draft).dependencies) ? (object(p.draft).dependencies as unknown[]).filter((d):d is string=>typeof d==="string") : [],
      } : undefined,
      preferredAgentId: agentId(p.preferredAgentId),
    };
  });
  const activeProjectId = projects.some((p) => p.id === r.activeProjectId)
    ? (r.activeProjectId as string)
    : projects[0].id;
  const taskIds = new Set<string>();
  const tasks: Task[] = (Array.isArray(r.tasks) ? r.tasks : [])
    .filter((t) => t && typeof t === "object")
    .map((value) => {
      const t = object(value);
      let id = str(t.id, newId("task"));
      if (taskIds.has(id)) {
        if (strict) throw new Error("Duplicate task IDs in backup.");
        id = newId("task");
      }
      taskIds.add(id);
      const status = ["backlog", "running", "review", "done"].includes(
        str(t.status),
      )
        ? (t.status as Task["status"])
        : "backlog";
      return {
        id,
        title: str(t.title, "Untitled task"),
        prompt: str(t.prompt),
        agentId: agentId(t.agentId),
        cwd: str(t.cwd) || undefined,
        projectId: projects.some((p) => p.id === t.projectId)
          ? (t.projectId as string)
          : activeProjectId,
        mode: t.mode === "headless" ? "headless" : "interactive",
        status: status === "running" ? "backlog" : status,
        priority:
          t.priority === "high" || t.priority === "low" ? t.priority : "normal",
        createdAt: finite(t.createdAt, Date.now()),
        archived: t.archived === true,
        interrupted: status === "running" || t.interrupted === true,
        queued: false,
        attention: str(t.attention) || undefined,
        isolation: t.isolation === true,
        worktree: str(t.worktree) || undefined,
        dependencies: Array.isArray(t.dependencies)
          ? t.dependencies.filter(
              (d): d is string => typeof d === "string" && d !== id,
            )
          : [],
        reviewNotes: str(t.reviewNotes),
        reviewedAt: typeof t.reviewedAt === "number" ? t.reviewedAt : undefined,
        lastExitCode:
          typeof t.lastExitCode === "number" ? t.lastExitCode : undefined,
      };
    });
  for (const t of tasks)
    t.dependencies = t.dependencies?.filter((id) => taskIds.has(id));
  return {
    version: 7,
    projects,
    activeProjectId,
    agents,
    tasks,
    settings: normalizeSettings(r.settings),
    usage: normalizeRuns(r.usage),
    targets: Object.fromEntries(
      Object.entries(object(r.targets)).filter(
        (v): v is [string, boolean] => typeof v[1] === "boolean",
      ),
    ),
    boardCollapsed: r.boardCollapsed === true,
    boardWidth: Math.max(240, Math.min(480, finite(r.boardWidth, 292))),
    templates: (Array.isArray(r.templates) ? r.templates : [])
      .filter(
        (t) =>
          t &&
          typeof t.name === "string" &&
          typeof t.draft?.prompt === "string",
      )
      .map((t) => ({
        id: str(t.id, newId("template")),
        name: t.name,
        draft: {
          title: str(t.draft.title),
          prompt: t.draft.prompt,
          agentId: agentId(t.draft.agentId),
          mode: t.draft.mode === "headless" ? "headless" : "interactive",
          cwd: str(t.draft.cwd)||undefined,
          priority: t.draft.priority === "high" || t.draft.priority === "low" ? t.draft.priority : "normal",
          isolation: t.draft.isolation === true,
        },
      })),
  };
}

export function redactWorkspace(w: Workspace): Workspace {
  return {
    ...w,
    settings: {
      ...w.settings,
      openRouter: { ...w.settings.openRouter, apiKey: "" },
    },
    agents: w.agents.map((a) => ({
      ...a,
      env: Object.fromEntries(
        Object.entries(a.env).map(([k, v]) => [
          k,
          !/^\{[a-z_]+\}$/.test(v)
            ? ""
            : v,
        ]),
      ),
    })),
  };
}
export function retainRuns(runs: RunRecord[], limit: number): RunRecord[] {
  const completed = runs.filter((r) => r.outcome !== "running").slice(-limit);
  const keep = new Set(completed.map((r) => r.id));
  return runs.filter((r) => r.outcome === "running" || keep.has(r.id));
}
export function taskBlocker(task: Task, tasks: Task[]): string | undefined {
  const unfinished = task.dependencies
    ?.map((id) => tasks.find((t) => t.id === id))
    .filter((t) => t && t.status !== "done");
  return unfinished?.length
    ? `Waiting for ${unfinished.map((t) => t!.title).join(", ")}`
    : undefined;
}
export function queueCandidates(tasks: Task[]): Task[] {
  const rank = { high: 0, normal: 1, low: 2 };
  return tasks
    .filter(
      (t) =>
        t.queued &&
        t.status === "backlog" &&
        !t.archived &&
        !taskBlocker(t, tasks),
    )
    .sort(
      (a, b) => rank[a.priority ?? "normal"] - rank[b.priority ?? "normal"],
    );
}
export function hasDependencyCycle(tasks: Task[]): boolean {
  const map = new Map(tasks.map((t) => [t.id, t.dependencies ?? []]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return true;
    if (visited.has(id)) return false;
    active.add(id);
    if ((map.get(id) ?? []).some(visit)) return true;
    active.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((t) => visit(t.id));
}
