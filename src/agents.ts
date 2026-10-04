// Agent catalog model. Agents used to be a hardcoded constant in App.tsx;
// they are now data — user-editable in the Agents manager and persisted with
// the workspace — so any CLI coding agent can be plugged in without a rebuild.

import { TaskMode } from "./tasks";
import { Settings } from "./settings";

/** Placeholder in a seed-args template that is replaced with the task prompt. */
export const PROMPT_TOKEN = "{prompt}";

/**
 * Where an agent's model access comes from. `native` = the CLI's own auth
 * (whatever it already reads from the environment or its config); `openrouter`
 * = routed through the OpenRouter credentials in Settings, substituted into
 * this agent's env/args via the tokens below.
 */
export type AgentProvider = "native" | "openrouter";

export interface AgentConfig {
  /** Stable id referenced by pane slots and task cards. */
  id: string;
  name: string;
  /** Executable on PATH (npm `.cmd` shims are resolved by the backend). */
  program: string;
  accent: string;
  /**
   * Off = hidden from every pane picker and the task composer. Kept in the
   * catalog (and in run history) so turning it back on restores its config.
   */
  enabled: boolean;
  provider: AgentProvider;
  /**
   * Per-agent model override for an openrouter agent; empty falls back to the
   * default model in Settings.
   */
  model: string;
  /**
   * Environment variables set on the spawned process. Values may contain the
   * OPENROUTER tokens; anything that resolves empty is dropped rather than
   * exported as an empty string.
   */
  env: Record<string, string>;
  /**
   * Launch-arg templates for a seeded run, one per mode. Each element is one
   * argv entry; PROMPT_TOKEN inside an element is replaced with the prompt.
   * Args go straight to the process (no shell), so prompts never need quoting.
   */
  interactiveArgs: string[];
  headlessArgs: string[];
}

/**
 * Tokens substituted into an agent's env values and launch args at spawn.
 * OPENROUTER_MODEL_TOKEN resolves to the agent's own model override when it
 * has one, else the default model in Settings.
 */
export const OPENROUTER_KEY_TOKEN = "{openrouter_key}";
export const OPENROUTER_BASE_TOKEN = "{openrouter_base}";
export const OPENROUTER_MODEL_TOKEN = "{openrouter_model}";

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

export const DEFAULT_AGENTS: AgentConfig[] = [
  {
    id: "claude",
    name: "Claude Code",
    program: "claude",
    accent: "#d97757",
    enabled: true,
    provider: "native",
    model: "",
    env: {},
    // `claude "<prompt>"` seeds an interactive session; `-p` prints headlessly.
    interactiveArgs: [PROMPT_TOKEN],
    headlessArgs: ["-p", PROMPT_TOKEN],
  },
  {
    id: "codex",
    name: "Codex",
    program: "codex",
    accent: "#10a37f",
    enabled: true,
    provider: "native",
    model: "",
    env: {},
    // `codex "<prompt>"` is interactive; `codex exec "<prompt>"` is non-interactive.
    interactiveArgs: [PROMPT_TOKEN],
    headlessArgs: ["exec", PROMPT_TOKEN],
  },
];

/** The fields a user edits in the agent manager; ids are assigned by App. */
export type AgentDraft = Omit<AgentConfig, "id">;

/**
 * Starting points offered by the agent manager's "New from template" menu.
 * Every field stays editable afterwards — CLIs disagree about which variables
 * they read, so these are a head start, not a compatibility promise.
 */
export interface AgentTemplate {
  id: string;
  label: string;
  hint: string;
  draft: AgentDraft;
}

const openRouterEnv = (extra: Record<string, string> = {}) => ({
  OPENAI_API_KEY: OPENROUTER_KEY_TOKEN,
  OPENAI_BASE_URL: OPENROUTER_BASE_TOKEN,
  ...extra,
});

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: "blank",
    label: "Blank agent",
    hint: "Any CLI on your PATH, using its own authentication.",
    draft: {
      name: "",
      program: "",
      accent: ACCENT_PRESETS[2],
      enabled: true,
      provider: "native",
      model: "",
      env: {},
      interactiveArgs: [PROMPT_TOKEN],
      headlessArgs: [PROMPT_TOKEN],
    },
  },
  {
    id: "openrouter-openai",
    label: "OpenAI-compatible CLI via OpenRouter",
    hint: "Points OPENAI_API_KEY / OPENAI_BASE_URL at OpenRouter — the mapping most OpenAI-compatible CLIs read.",
    draft: {
      name: "OpenRouter agent",
      program: "",
      accent: "#a371f7",
      enabled: true,
      provider: "openrouter",
      model: "",
      env: openRouterEnv({ OPENAI_MODEL: OPENROUTER_MODEL_TOKEN }),
      interactiveArgs: [PROMPT_TOKEN],
      headlessArgs: [PROMPT_TOKEN],
    },
  },
  {
    id: "openrouter-aider",
    label: "Aider via OpenRouter",
    hint: "Sets OPENROUTER_API_KEY and passes --model openrouter/<model>.",
    draft: {
      name: "Aider (OpenRouter)",
      program: "aider",
      accent: "#3fb950",
      enabled: true,
      provider: "openrouter",
      model: "",
      env: { OPENROUTER_API_KEY: OPENROUTER_KEY_TOKEN },
      interactiveArgs: [
        "--model",
        `openrouter/${OPENROUTER_MODEL_TOKEN}`,
        "--message",
        PROMPT_TOKEN,
      ],
      headlessArgs: [
        "--model",
        `openrouter/${OPENROUTER_MODEL_TOKEN}`,
        "--yes",
        "--message",
        PROMPT_TOKEN,
      ],
    },
  },
  {
    id: "openrouter-opencode",
    label: "OpenCode via OpenRouter",
    hint: "Sets OPENROUTER_API_KEY; `run` is OpenCode's non-interactive mode.",
    draft: {
      name: "OpenCode (OpenRouter)",
      program: "opencode",
      accent: "#58a6ff",
      enabled: true,
      provider: "openrouter",
      model: "",
      env: { OPENROUTER_API_KEY: OPENROUTER_KEY_TOKEN },
      interactiveArgs: ["--model", `openrouter/${OPENROUTER_MODEL_TOKEN}`],
      headlessArgs: [
        "run",
        "--model",
        `openrouter/${OPENROUTER_MODEL_TOKEN}`,
        PROMPT_TOKEN,
      ],
    },
  },
  ...DEFAULT_AGENTS.map(({ id, ...draft }): AgentTemplate => ({
    id: `builtin-${id}`,
    label: draft.name,
    hint: `Re-add the built-in ${draft.name} entry, using its own authentication.`,
    draft: { ...draft, env: { ...draft.env } },
  })),
];

/**
 * Substitute the provider tokens in one arg or env value. The model token
 * prefers the agent's own override, then the default model in Settings.
 */
export function resolveTokens(
  text: string,
  agent: AgentConfig,
  settings: Settings,
): string {
  const or = settings.openRouter;
  return text
    .split(OPENROUTER_KEY_TOKEN)
    .join(or.apiKey)
    .split(OPENROUTER_BASE_TOKEN)
    .join(or.baseUrl)
    .split(OPENROUTER_MODEL_TOKEN)
    .join(agent.model || or.model);
}

/**
 * Build the argv that seeds a fresh run with the task prompt. Provider tokens
 * are resolved here too, so `--model openrouter/{openrouter_model}` works.
 */
export function seedArgs(
  agent: AgentConfig,
  prompt: string,
  mode: TaskMode,
  settings: Settings,
): string[] {
  const p = prompt.trim();
  if (!p) return [];
  const template = mode === "headless" ? agent.headlessArgs : agent.interactiveArgs;
  return template.map((a) =>
    resolveTokens(a.split(PROMPT_TOKEN).join(p), agent, settings),
  );
}

/**
 * Claude Code, whatever the catalog calls it: Crucible's hooks only work with
 * that CLI. Matched on the program (`claude`, `claude.exe`, a path to either).
 */
export function isClaudeCode(agent: Pick<AgentConfig, "program">): boolean {
  const file = agent.program.trim().split(/[\\/]/).pop() ?? "";
  return /^claude(?:\.(?:exe|cmd))?$/i.test(file);
}

/**
 * Launch args with Crucible's hook settings in front. An agent whose own args
 * already pass `--settings` keeps them: Claude Code reads only one.
 */
export function withHookSettings(args: string[], path: string): string[] {
  return args.some((a) => a === "--settings" || a.startsWith("--settings="))
    ? args
    : ["--settings", path, ...args];
}

/**
 * Environment for a spawned agent. Tokens are resolved and anything left empty
 * is dropped — exporting `OPENAI_API_KEY=""` reads as "authenticated with
 * nothing" to most CLIs, which is worse than leaving the variable unset.
 * OpenRouter agents also get the canonical OPENROUTER_* trio as a fallback,
 * unless the agent's own map already names those variables.
 */
export function launchEnv(
  agent: AgentConfig,
  settings: Settings,
): Record<string, string> {
  const source: Record<string, string> = { ...agent.env };
  if (agent.provider === "openrouter") {
    const canonical: Record<string, string> = {
      OPENROUTER_API_KEY: OPENROUTER_KEY_TOKEN,
      OPENROUTER_BASE_URL: OPENROUTER_BASE_TOKEN,
      OPENROUTER_MODEL: OPENROUTER_MODEL_TOKEN,
    };
    for (const [k, v] of Object.entries(canonical)) {
      if (!(k in source)) source[k] = v;
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    const key = k.trim();
    if (!key) continue;
    const value = resolveTokens(v, agent, settings);
    if (value !== "") out[key] = value;
  }
  return out;
}

/**
 * Why this agent can't be launched right now, or undefined when it can.
 * Surfaced in the pane (instead of spawning a CLI that would just fail on a
 * missing key) and on the Settings page.
 */
export function launchBlockReason(
  agent: AgentConfig,
  settings: Settings,
): string | undefined {
  if (!agent.enabled) {
    return `${agent.name} is turned off in Settings → Agents.`;
  }
  if (agent.provider !== "openrouter") return undefined;
  if (!settings.openRouter.enabled) {
    return `${agent.name} routes through OpenRouter, which is turned off in Settings → Providers.`;
  }
  if (!settings.openRouter.apiKey) {
    return `${agent.name} routes through OpenRouter — add an API key in Settings → Providers.`;
  }
  if (!agent.model && !settings.openRouter.model) {
    return `${agent.name} has no model — set one on the agent or as the OpenRouter default in Settings.`;
  }
  return undefined;
}

/** Catalog entries a pane picker or the task composer may offer. */
export const enabledAgents = (agents: AgentConfig[]): AgentConfig[] =>
  agents.filter((a) => a.enabled);

/** Parse a `KEY=value` block (one per line) into an env map. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key) out[key] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Inverse of parseEnv, for populating the editor from a stored map. */
export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
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
      const env: Record<string, string> = {};
      if (a.env && typeof a.env === "object" && !Array.isArray(a.env)) {
        for (const [k, v] of Object.entries(a.env as Record<string, unknown>)) {
          if (k.trim()) env[k.trim()] = typeof v === "string" ? v : String(v);
        }
      }
      return {
        id,
        name: str(a.name, builtin?.name ?? id),
        program: str(a.program, builtin?.program ?? id),
        accent: str(a.accent, builtin?.accent ?? "#8b949e"),
        // Blobs written before agents could be switched off predate the field
        // entirely, so a missing value has to mean "on".
        enabled: typeof a.enabled === "boolean" ? a.enabled : true,
        provider: a.provider === "openrouter" ? "openrouter" : "native",
        model: typeof a.model === "string" ? a.model : "",
        env,
        interactiveArgs: args(
          a.interactiveArgs,
          builtin?.interactiveArgs ?? [PROMPT_TOKEN],
        ),
        headlessArgs: args(a.headlessArgs, builtin?.headlessArgs ?? [PROMPT_TOKEN]),
      };
    });
  if (list.length === 0) return DEFAULT_AGENTS;
  // The UI won't let you switch the last agent off, but a hand-edited or
  // truncated blob could still arrive with none on — panes need something.
  if (!list.some((a) => a.enabled)) list[0] = { ...list[0], enabled: true };
  return list;
}
