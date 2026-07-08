// Agent catalog model. Agents used to be a hardcoded constant in App.tsx;
// they are now data — user-editable in the Agents manager and persisted with
// the workspace — so any CLI coding agent can be plugged in without a rebuild.

import { TaskMode } from "./tasks";

/** Placeholder in a seed-args template that is replaced with the task prompt. */
export const PROMPT_TOKEN = "{prompt}";

export interface AgentConfig {
  /** Stable id referenced by pane slots and task cards. */
  id: string;
  name: string;
  /** Executable on PATH (npm `.cmd` shims are resolved by the backend). */
  program: string;
  accent: string;
  /**
   * Launch-arg templates for a seeded run, one per mode. Each element is one
   * argv entry; PROMPT_TOKEN inside an element is replaced with the prompt.
   * Args go straight to the process (no shell), so prompts never need quoting.
   */
  interactiveArgs: string[];
  headlessArgs: string[];
}

export const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: "claude",
    name: "Claude Code",
    program: "claude",
    accent: "#d97757",
    // `claude "<prompt>"` seeds an interactive session; `-p` prints headlessly.
    interactiveArgs: [PROMPT_TOKEN],
    headlessArgs: ["-p", PROMPT_TOKEN],
  },
  {
    id: "codex",
    name: "Codex",
    program: "codex",
    accent: "#10a37f",
    // `codex "<prompt>"` is interactive; `codex exec "<prompt>"` is non-interactive.
    interactiveArgs: [PROMPT_TOKEN],
    headlessArgs: ["exec", PROMPT_TOKEN],
  },
];

/** Accent choices offered by the agent editor (GitHub-dark friendly). */
export const ACCENT_PRESETS = [
  "#d97757", // clay
  "#10a37f", // teal
  "#58a6ff", // blue
  "#a371f7", // violet
  "#3fb950", // green
  "#d29922", // amber
  "#db61a2", // pink
  "#f85149", // red
  "#79c0ff", // sky
  "#8b949e", // gray
];

/** Build the argv that seeds a fresh run with the task prompt. */
export function seedArgs(
  agent: AgentConfig,
  prompt: string,
  mode: TaskMode,
): string[] {
  const p = prompt.trim();
  if (!p) return [];
  const template = mode === "headless" ? agent.headlessArgs : agent.interactiveArgs;
  return template.map((a) => a.split(PROMPT_TOKEN).join(p));
}

/**
 * Parse an args template typed as one line into argv entries. Splits on
 * whitespace; double quotes group words ( `--flag "two words"` → 2 entries ).
 */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2]);
  return out;
}

/** Inverse of parseArgs, for populating the editor from stored templates. */
export function formatArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) || a === "" ? `"${a}"` : a)).join(" ");
}

/**
 * Validate a persisted catalog (or migrate an older blob without one).
 * Unknown shapes fall back per-field to the built-in defaults so a schema
 * addition never bricks a stored workspace.
 */
export function normalizeAgents(raw: unknown): AgentConfig[] {
  if (!Array.isArray(raw)) return DEFAULT_AGENTS;
  const list = raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .filter((a) => typeof a.id === "string" && a.id !== "")
    .map((a): AgentConfig => {
      const id = a.id as string;
      const builtin = DEFAULT_AGENTS.find((d) => d.id === id);
      const str = (v: unknown, fb: string) =>
        typeof v === "string" && v ? v : fb;
      const args = (v: unknown, fb: string[]) =>
        Array.isArray(v) ? v.map(String) : fb;
      return {
        id,
        name: str(a.name, builtin?.name ?? id),
        program: str(a.program, builtin?.program ?? id),
        accent: str(a.accent, builtin?.accent ?? "#8b949e"),
        interactiveArgs: args(
          a.interactiveArgs,
          builtin?.interactiveArgs ?? [PROMPT_TOKEN],
        ),
        headlessArgs: args(a.headlessArgs, builtin?.headlessArgs ?? [PROMPT_TOKEN]),
      };
    });
  return list.length > 0 ? list : DEFAULT_AGENTS;
}
