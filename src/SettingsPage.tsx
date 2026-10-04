// Settings page: every knob that changes real behaviour elsewhere in the app.
// Pure presentation over the Settings blob owned by App — this component reads
// `settings` and reports patches; it never stores app state of its own beyond
// transient UI (a revealed key, a two-step confirmation, fetched model ids).

import { createContext, isValidElement, ReactNode, Children, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AgentConfig,
  launchBlockReason,
  OPENROUTER_BASE_TOKEN,
  OPENROUTER_KEY_TOKEN,
  OPENROUTER_MODEL_TOKEN,
} from "./agents";
import {
  CHAIN_RANGE,
  CONCURRENCY_RANGE,
  CURSOR_STYLES,
  CursorStyle,
  DEFAULT_REVIEW_INSTRUCTIONS,
  DESKTOP_NOTIFICATIONS,
  DesktopNotifications,
  FONT_SIZE_RANGE,
  HEADLESS_COMPLETIONS,
  HeadlessCompletion,
  REVIEW_INSTRUCTIONS_MAX,
  SCROLLBACK_RANGE,
  Settings,
  USAGE_LIMITS,
} from "./settings";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  DatabaseIcon,
  KanbanIcon,
  KeyIcon,
  SettingsIcon,
  TerminalIcon,
  TrashIcon,
} from "./icons";
import "./SettingsPage.css";

const categories = ["Agents", "Providers — OpenRouter", "Terminal", "Task board", "Workspace", "History & data"];
const SettingsFilter = createContext({category:"Agents", query:""});
function searchable(node: ReactNode): string {
  return Children.toArray(node).map(item => {
    if (!isValidElement<{label?:string;hint?:string;children?:ReactNode}>(item)) return typeof item === "string" ? item : "";
    return `${item.props.label??""} ${item.props.hint??""} ${searchable(item.props.children)}`;
  }).join(" ");
}

interface SettingsPageProps {
  settings: Settings;
  /** Shallow patch — App merges and persists. */
  onChange: (patch: Partial<Settings>) => void;
  agents: AgentConfig[];
  /** Agents with a live process; switching one off would strand its session. */
  busyAgentIds: string[];
  onToggleAgent: (id: string, enabled: boolean) => void;
  /** Opens the agent manager dialog (add/edit/delete). */
  onManageAgents: () => void;
  /** Run records currently stored, for the history section. */
  runCount: number;
  onClearUsage: () => void;
  /** Serialize the whole persisted workspace for a backup. */
  exportWorkspace: () => string;
  /** Apply a pasted backup; returns an error message when it can't be read. */
  onImportWorkspace: (json: string) => Promise<string | undefined>;
  /** Wipe stored state and start over. */
  onResetWorkspace: () => void;
}

/**
 * Keep a typed number inside its range. The min/max attributes only constrain
 * the spinner, so a hand-typed 999 would otherwise reach the terminal live.
 */
const clamped = (raw: string, fallback: number, min: number, max: number) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || raw.trim() === "") return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
};

/** A switch. Rendered as a real button so it keyboard-activates for free. */
function Toggle({
  checked,
  onChange,
  label,
  disabled,
  disabledReason,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={disabled ? disabledReason : undefined}
      disabled={disabled}
      className={`set-toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="set-toggle-knob" />
    </button>
  );
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  const {category,query}=useContext(SettingsFilter);
  if (query ? !`${title} ${hint} ${searchable(children)}`.toLowerCase().includes(query.toLowerCase()) : category!==title) return null;
  return (
    <section className="set-section">
      <header className="set-section-head">
        <span className="set-section-icon">{icon}</span>
        <div>
          <h2 className="set-section-title">{title}</h2>
          <p className="set-section-hint">{hint}</p>
        </div>
      </header>
      <div className="set-rows">{children}</div>
    </section>
  );
}

/** One setting: label + explanation on the left, its control on the right. */
function Row({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
  /** Set when the control is a single labelable input. */
  htmlFor?: string;
}) {
  return (
    <div className="set-row">
      <div className="set-row-lead">
        {htmlFor ? (
          <label className="set-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="set-row-label">{label}</span>
        )}
        <p className="set-row-hint">{hint}</p>
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

/**
 * A destructive action that asks once. Clicking arms it for a few seconds;
 * a second click runs it. Cheaper than a modal and keeps the page dense.
 */
function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  icon,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const click = () => {
    if (!armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    window.clearTimeout(timer.current);
    setArmed(false);
    onConfirm();
  };

  return (
    <button
      type="button"
      className={`set-btn danger ${armed ? "armed" : ""}`}
      disabled={disabled}
      onClick={click}
      onBlur={() => setArmed(false)}
    >
      {icon}
      {armed ? confirmLabel : label}
    </button>
  );
}

export default function SettingsPage({
  settings,
  onChange,
  agents,
  busyAgentIds,
  onToggleAgent,
  onManageAgents,
  runCount,
  onClearUsage,
  exportWorkspace,
  onImportWorkspace,
  onResetWorkspace,
}: SettingsPageProps) {
  const [category,setCategory]=useState("Agents");
  const [query,setQuery]=useState("");
  const [readiness,setReadiness]=useState<Record<string,{checking?:boolean;message:string;error?:boolean}>>({});
  const checkAgent=async(agent:AgentConfig)=>{
    setReadiness(v=>({...v,[agent.id]:{checking:true,message:"Checking installation…"}}));
    try { const result=await invoke<{path:string;version:string}>("check_agent",{program:agent.program}); setReadiness(v=>({...v,[agent.id]:{message:`${result.version||"Installed"} · ${result.path}. Sign in through the CLI if needed.`}})); }
    catch(e) {setReadiness(v=>({...v,[agent.id]:{message:String(e),error:true}}));}
  };
  const or = settings.openRouter;
  const setOr = (patch: Partial<typeof or>) =>
    onChange({ openRouter: { ...or, ...patch } });

  // ---- OpenRouter: key check and model list (both live, both optional) ----
  const [showKey, setShowKey] = useState(false);
  const [keyCheck, setKeyCheck] = useState<
    { state: "idle" | "checking" } | { state: "ok" | "error"; message: string }
  >({ state: "idle" });
  const [models, setModels] = useState<string[]>([]);
  const [modelLoad, setModelLoad] = useState<"idle" | "loading" | "error">(
    "idle",
  );

  // A key edit invalidates the last check result.
  useEffect(() => setKeyCheck({ state: "idle" }), [or.apiKey, or.baseUrl]);

  const checkKey = async () => {
    setKeyCheck({ state: "checking" });
    try {
      const res = await fetch(`${or.baseUrl.replace(/\/+$/, "")}/key`, {
        headers: { Authorization: `Bearer ${or.apiKey}` },
      });
      if (!res.ok) {
        setKeyCheck({
          state: "error",
          message: `OpenRouter replied ${res.status} ${res.statusText}`,
        });
        return;
      }
      const body = (await res.json()) as {
        data?: { label?: string; usage?: number; limit?: number | null };
      };
      const label = body.data?.label?.trim();
      setKeyCheck({
        state: "ok",
        message: label ? `Key accepted — ${label}` : "Key accepted",
      });
    } catch (err) {
      setKeyCheck({
        state: "error",
        message: `Could not reach OpenRouter: ${String(err)}`,
      });
    }
  };

  const loadModels = async () => {
    setModelLoad("loading");
    try {
      const res = await fetch(`${or.baseUrl.replace(/\/+$/, "")}/models`);
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { data?: { id?: string }[] };
      const ids = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string")
        .sort();
      setModels(ids);
      setModelLoad(ids.length > 0 ? "idle" : "error");
    } catch {
      setModelLoad("error");
    }
  };

  // ---- Backup / restore ----
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreText, setRestoreText] = useState("");
  const [restoreError, setRestoreError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const [backupMessage,setBackupMessage]=useState("");
  const saveBackup=async()=>{try{const path=await invoke<string|null>("export_backup",{contents:exportWorkspace()});if(path)setBackupMessage(`Backup saved to ${path}`);}catch(e){setBackupMessage(String(e));}};
  const openBackup=async()=>{try{const contents=await invoke<string|null>("import_backup");if(contents){setRestoreText(contents);setRestoreError(undefined);setRestoreOpen(true);}}catch(e){setBackupMessage(String(e));}};
  const recover=async()=>{try{const result=await invoke<{workspace:unknown}>("load_workspace",{recovery:true});const error=await onImportWorkspace(JSON.stringify(result.workspace));setBackupMessage(error??"Previous snapshot restored.");}catch(e){setBackupMessage(String(e));}};

  const copyBackup = async () => {
    try {
      await navigator.clipboard.writeText(exportWorkspace());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // No clipboard access — fall back to showing the JSON to copy by hand.
      setRestoreOpen(true);
      setRestoreText(exportWorkspace());
      setRestoreError("Clipboard unavailable — copy the text above by hand.");
    }
  };

  const runRestore = async () => {
    const error = await onImportWorkspace(restoreText);
    setRestoreError(error);
    if (!error) {
      setRestoreOpen(false);
      setRestoreText("");
    }
  };

  const enabledCount = agents.filter((a) => a.enabled).length;
  const lastEnabled = (a: AgentConfig) => a.enabled && enabledCount <= 1;

  return (
    <SettingsFilter.Provider value={{category,query}}><div className="settings-page">
      <div className="settings-inner">
        <header className="settings-head">
          <div className="settings-lead">
            <h1 className="settings-title">
              <SettingsIcon width={17} height={17} /> Settings
            </h1>
            <p className="settings-sub">
              Everything here takes effect immediately and is saved with the
              workspace.
            </p>
          </div>
        </header>

        <nav className="settings-navigation" aria-label="Settings categories">{categories.map(c=><button key={c} className={category===c&&!query?"selected":""} aria-pressed={category===c&&!query} onClick={()=>{setCategory(c);setQuery("");}}>{c==="Providers — OpenRouter"?"Providers":c}</button>)}<input type="search" aria-label="Search settings" placeholder="Find a setting…" value={query} onChange={e=>setQuery(e.target.value)}/></nav>
        {query&&!categories.some(c=>`${c}`.toLowerCase().includes(query.toLowerCase()))&&<p className="muted">Matching settings sections are shown below.</p>}

        <Section
          icon={<BotIcon width={15} height={15} />}
          title="Agents"
          hint="Which agents pane pickers and the task composer offer. Switching one off keeps its configuration — and its run history — for later."
        >
          <div className="set-agents">
            {agents.map((agent) => {
              const busy = busyAgentIds.includes(agent.id);
              const blocked = agent.enabled
                ? launchBlockReason(agent, settings)
                : undefined;
              const locked = busy || lastEnabled(agent);
              return (
                <div
                  key={agent.id}
                  className={`set-agent ${agent.enabled ? "" : "off"}`}
                  style={
                    { "--agent-accent": agent.accent } as React.CSSProperties
                  }
                >
                  <span className="set-agent-dot" aria-hidden="true" />
                  <div className="set-agent-body">
                    <div className="set-agent-line">
                      <span className="set-agent-name">{agent.name}</span>
                      <code className="set-agent-prog">{agent.program}</code>
                      {agent.provider === "openrouter" && (
                        <span
                          className="set-tag"
                          title={
                            agent.model
                              ? `Routed through OpenRouter — ${agent.model}`
                              : "Routed through OpenRouter — uses the default model below"
                          }
                        >
                          OpenRouter
                        </span>
                      )}
                      {busy && <span className="set-tag live">running</span>}
                    </div>
                    {blocked ? (
                      <p className="set-agent-warn">
                        <AlertTriangleIcon width={12} height={12} /> {blocked}
                      </p>
                    ) : (
                      <p className="set-agent-hint">
                        {agent.enabled
                          ? "Available to panes and tasks."
                          : "Hidden from pane pickers and the task composer."}
                      </p>
                    )}
                    {readiness[agent.id]&&<p className={readiness[agent.id].error?"set-agent-warn":"set-agent-hint"} role="status">{readiness[agent.id].message}</p>}
                  </div>
                  <button className="set-btn" disabled={readiness[agent.id]?.checking} onClick={()=>void checkAgent(agent)}>{readiness[agent.id]?.checking?"Checking…":"Check installation"}</button>
                  <Toggle
                    checked={agent.enabled}
                    label={`Enable ${agent.name}`}
                    disabled={locked}
                    disabledReason={
                      busy
                        ? "This agent has a live session — stop it first"
                        : "At least one agent has to stay on"
                    }
                    onChange={(next) => onToggleAgent(agent.id, next)}
                  />
                </div>
              );
            })}
          </div>
          <div className="set-actions">
            <button type="button" className="set-btn" onClick={onManageAgents}>
              <BotIcon width={13} height={13} /> Add, edit or remove agents…
            </button>
            <span className="set-actions-note">
              {enabledCount} of {agents.length} available
            </span>
          </div>
        </Section>

        <Section
          icon={<KeyIcon width={15} height={15} />}
          title="Providers — OpenRouter"
          hint="Credentials for agents whose model access is set to OpenRouter. Credentials are protected by your Windows account and kept separately from workspace data."
        >
          <Row
            label="Route agents through OpenRouter"
            hint="Off blocks every OpenRouter agent from launching, without changing its configuration."
          >
            <Toggle
              checked={or.enabled}
              label="Enable OpenRouter"
              onChange={(enabled) => setOr({ enabled })}
            />
          </Row>

          <Row
            label="API key"
            hint="Substituted wherever an agent uses the key token."
            htmlFor="set-or-key"
          >
            <div className="set-key">
              <input
                id="set-or-key"
                className="set-input mono"
                type={showKey ? "text" : "password"}
                value={or.apiKey}
                placeholder="sk-or-v1-…"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setOr({ apiKey: e.target.value })}
              />
              <button
                type="button"
                className="set-btn subtle"
                aria-pressed={showKey}
                onClick={() => setShowKey((s) => !s)}
              >
                {showKey ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className="set-btn"
                disabled={!or.apiKey || keyCheck.state === "checking"}
                onClick={checkKey}
              >
                {keyCheck.state === "checking" ? "Checking…" : "Test key"}
              </button>
            </div>
          </Row>
          {keyCheck.state === "ok" && (
            <p className="set-note ok">
              <CheckIcon width={12} height={12} /> {keyCheck.message}
            </p>
          )}
          {keyCheck.state === "error" && (
            <p className="set-note bad">
              <AlertTriangleIcon width={12} height={12} /> {keyCheck.message}
            </p>
          )}

          <Row
            label="Base URL"
            hint="The OpenAI-compatible endpoint agents are pointed at."
            htmlFor="set-or-base"
          >
            <input
              id="set-or-base"
              className="set-input mono wide"
              value={or.baseUrl}
              spellCheck={false}
              onChange={(e) => setOr({ baseUrl: e.target.value })}
            />
          </Row>

          <Row
            label="Default model"
            hint="Used by OpenRouter agents that don't name a model of their own."
            htmlFor="set-or-model"
          >
            <div className="set-key">
              <input
                id="set-or-model"
                className="set-input mono"
                list="set-or-models"
                value={or.model}
                placeholder="anthropic/claude-sonnet-4.5"
                spellCheck={false}
                onChange={(e) => setOr({ model: e.target.value })}
              />
              <datalist id="set-or-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <button
                type="button"
                className="set-btn"
                disabled={modelLoad === "loading"}
                onClick={loadModels}
              >
                {modelLoad === "loading"
                  ? "Loading…"
                  : models.length > 0
                    ? `${models.length} loaded`
                    : "Load models"}
              </button>
            </div>
          </Row>
          {modelLoad === "error" && (
            <p className="set-note bad">
              <AlertTriangleIcon width={12} height={12} /> Couldn't fetch the
              model list — type the slug by hand.
            </p>
          )}
          <p className="set-note">
            An agent set to OpenRouter gets <code>{OPENROUTER_KEY_TOKEN}</code>,{" "}
            <code>{OPENROUTER_BASE_TOKEN}</code> and{" "}
            <code>{OPENROUTER_MODEL_TOKEN}</code> substituted into its
            environment and launch args, plus <code>OPENROUTER_API_KEY</code>,{" "}
            <code>OPENROUTER_BASE_URL</code> and <code>OPENROUTER_MODEL</code> as
            a fallback. Which variables a CLI actually reads is up to that CLI —
            edit the mapping per agent in the agent editor.
          </p>
        </Section>

        <Section
          icon={<TerminalIcon width={15} height={15} />}
          title="Terminal"
          hint="Applied live to every pane, including sessions already running."
        >
          <Row
            label="Font size"
            hint="Pixel size of terminal text; panes refit as it changes."
            htmlFor="set-font-size"
          >
            <input
              id="set-font-size"
              className="set-input num"
              type="number"
              min={FONT_SIZE_RANGE.min}
              max={FONT_SIZE_RANGE.max}
              value={settings.fontSize}
              onChange={(e) =>
                onChange({
                  fontSize: clamped(
                    e.target.value,
                    settings.fontSize,
                    FONT_SIZE_RANGE.min,
                    FONT_SIZE_RANGE.max,
                  ),
                })
              }
            />
          </Row>
          <Row
            label="Font family"
            hint="Leave empty for the built-in Cascadia Code / Consolas stack."
            htmlFor="set-font-family"
          >
            <input
              id="set-font-family"
              className="set-input mono wide"
              value={settings.fontFamily}
              placeholder="Cascadia Code, Consolas, monospace"
              spellCheck={false}
              onChange={(e) => onChange({ fontFamily: e.target.value })}
            />
          </Row>
          <Row
            label="Scrollback"
            hint="Lines of history each pane keeps. Higher costs memory per pane."
            htmlFor="set-scrollback"
          >
            <input
              id="set-scrollback"
              className="set-input num"
              type="number"
              min={SCROLLBACK_RANGE.min}
              max={SCROLLBACK_RANGE.max}
              step={500}
              value={settings.scrollback}
              onChange={(e) =>
                onChange({
                  scrollback: clamped(
                    e.target.value,
                    settings.scrollback,
                    SCROLLBACK_RANGE.min,
                    SCROLLBACK_RANGE.max,
                  ),
                })
              }
            />
          </Row>
          <Row label="Cursor" hint="Shape of the terminal caret." htmlFor="set-cursor">
            <select
              id="set-cursor"
              className="set-input"
              value={settings.cursorStyle}
              onChange={(e) =>
                onChange({ cursorStyle: e.target.value as CursorStyle })
              }
            >
              {CURSOR_STYLES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Blink the cursor" hint="Off is calmer with several panes open.">
            <Toggle
              checked={settings.cursorBlink}
              label="Blink the cursor"
              onChange={(cursorBlink) => onChange({ cursorBlink })}
            />
          </Row>
          <Row
            label="Copy on select"
            hint="Selecting text in a pane puts it on the clipboard straight away."
          >
            <Toggle
              checked={settings.copyOnSelect}
              label="Copy on select"
              onChange={(copyOnSelect) => onChange({ copyOnSelect })}
            />
          </Row>
        </Section>

        <Section
          icon={<KanbanIcon width={15} height={15} />}
          title="Task board"
          hint="How cards get launched, and what happens when their process ends."
        >
          <Row
            label="Start queued tasks automatically"
            hint="Off leaves a queued card in Backlog until you run it by hand."
          >
            <Toggle
              checked={settings.autoStartQueued}
              label="Start queued tasks automatically"
              onChange={(autoStartQueued) => onChange({ autoStartQueued })}
            />
          </Row>
          <Row
            label="Max concurrent task runs"
            hint="0 means the only limit is how many panes are free."
            htmlFor="set-concurrency"
          >
            <input
              id="set-concurrency"
              className="set-input num"
              type="number"
              min={CONCURRENCY_RANGE.min}
              max={CONCURRENCY_RANGE.max}
              value={settings.maxConcurrentRuns}
              onChange={(e) =>
                onChange({
                  maxConcurrentRuns: clamped(
                    e.target.value,
                    settings.maxConcurrentRuns,
                    CONCURRENCY_RANGE.min,
                    CONCURRENCY_RANGE.max,
                  ),
                })
              }
            />
          </Row>
          <Row
            label="When a headless run finishes"
            hint={
              HEADLESS_COMPLETIONS.find(
                (h) => h.id === settings.headlessCompletion,
              )?.hint ?? ""
            }
            htmlFor="set-headless"
          >
            <select
              id="set-headless"
              className="set-input"
              value={settings.headlessCompletion}
              onChange={(e) =>
                onChange({
                  headlessCompletion: e.target.value as HeadlessCompletion,
                })
              }
            >
              {HEADLESS_COMPLETIONS.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </select>
          </Row>
          <Row
            label="Review instructions"
            hint="Appended to every agent-review prompt. Leave blank to use the built-in checklist."
            htmlFor="set-review-instructions"
          >
            <div className="set-stack">
              <textarea
                id="set-review-instructions"
                className="set-input set-textarea"
                rows={5}
                maxLength={REVIEW_INSTRUCTIONS_MAX}
                value={settings.reviewInstructions}
                placeholder={DEFAULT_REVIEW_INSTRUCTIONS}
                onChange={(e) =>
                  onChange({ reviewInstructions: e.target.value })
                }
              />
              <button
                type="button"
                className="set-btn subtle"
                disabled={
                  settings.reviewInstructions === DEFAULT_REVIEW_INSTRUCTIONS
                }
                onClick={() =>
                  onChange({ reviewInstructions: DEFAULT_REVIEW_INSTRUCTIONS })
                }
              >
                Reset to default
              </button>
            </div>
          </Row>
          <Row
            label="Messages can start tasks"
            hint="A message to a teammate set to “Start a task” creates a headless task for it. Off pauses that for every teammate; messages still wait in their inboxes."
          >
            <Toggle
              checked={settings.messageStarts}
              label="Messages can start tasks"
              onChange={(messageStarts) => onChange({ messageStarts })}
            />
          </Row>
          <Row
            label="Longest message chain"
            hint="How many message-started tasks may follow one another (Ada asks Ben, Ben replies, …) before the next message waits for you."
            htmlFor="set-message-chain"
          >
            <input
              id="set-message-chain"
              className="set-input num"
              type="number"
              min={CHAIN_RANGE.min}
              max={CHAIN_RANGE.max}
              value={settings.messageChainLimit}
              onChange={(e) =>
                onChange({
                  messageChainLimit: clamped(
                    e.target.value,
                    settings.messageChainLimit,
                    CHAIN_RANGE.min,
                    CHAIN_RANGE.max,
                  ),
                })
              }
            />
          </Row>
          <Row
            label="Confirm before archiving a card"
            hint="Archive asks once before it hides a task. Archived tasks can be restored."
          >
            <Toggle
              checked={settings.confirmTaskDelete}
              label="Confirm before archiving a card"
              onChange={(confirmTaskDelete) => onChange({ confirmTaskDelete })}
            />
          </Row>
        </Section>

        <Section
          icon={<SettingsIcon width={15} height={15} />}
          title="Workspace"
          hint="Guard rails on the actions that reach every pane at once."
        >
          <Row label="Notify when work finishes" hint="Draw attention to Crucible in the Windows taskbar when a run finishes or fails."><Toggle checked={settings.notifyOnCompletion} label="Notify when work finishes" onChange={notifyOnCompletion=>onChange({notifyOnCompletion})}/></Row>
          <Row
            label="Desktop notifications"
            hint="A notification when an agent needs you or finishes a turn. The Dashboard shows the same status either way."
            htmlFor="set-desktop-notifications"
          >
            <select
              id="set-desktop-notifications"
              className="set-input"
              value={settings.desktopNotifications}
              onChange={(e) =>
                onChange({
                  desktopNotifications: e.target.value as DesktopNotifications,
                })
              }
            >
              {DESKTOP_NOTIFICATIONS.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          </Row>
          <Row
            label="Confirm “Stop all”"
            hint="Killing every session asks once first."
          >
            <Toggle
              checked={settings.confirmStopAll}
              label="Confirm Stop all"
              onChange={(confirmStopAll) => onChange({ confirmStopAll })}
            />
          </Row>
          <Row
            label="Broadcasts press Enter"
            hint="Off types the message into each pane and leaves it unsent, so you can review before submitting."
          >
            <Toggle
              checked={settings.broadcastAppendEnter}
              label="Broadcasts press Enter"
              onChange={(broadcastAppendEnter) =>
                onChange({ broadcastAppendEnter })
              }
            />
          </Row>
        </Section>

        <Section
          icon={<DatabaseIcon width={15} height={15} />}
          title="History & data"
          hint="The workspace — layout, agents, tasks, run history and these settings — is saved in the desktop application data folder."
        >
          <Row
            label="Record run history"
            hint="Off stops writing new records; the Activity page keeps what it already has."
          >
            <Toggle
              checked={settings.recordUsage}
              label="Record run history"
              onChange={(recordUsage) => onChange({ recordUsage })}
            />
          </Row>
          <Row
            label="Runs to keep"
            hint="Oldest records fall off past this."
            htmlFor="set-usage-limit"
          >
            <select
              id="set-usage-limit"
              className="set-input"
              value={settings.usageLimit}
              onChange={(e) =>
                onChange({ usageLimit: Number(e.target.value) })
              }
            >
              {USAGE_LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n} runs
                </option>
              ))}
            </select>
          </Row>
          <Row
            label="Stored run history"
            hint={`${runCount} record${runCount === 1 ? "" : "s"} on the Activity page. Live runs are always kept.`}
          >
            <ConfirmButton
              label="Clear history"
              confirmLabel="Click again to clear"
              disabled={runCount === 0}
              icon={<TrashIcon width={13} height={13} />}
              onConfirm={onClearUsage}
            />
          </Row>
          <Row
            label="Backup"
            hint="Saves projects, tasks, settings, and run history. API keys and literal environment values are omitted. Recorded output and file snapshots stay on this device."
          >
            <div className="set-key">
              <button type="button" className="set-btn" onClick={()=>void saveBackup()}>Save backup file</button>
              <button type="button" className="set-btn" onClick={()=>void openBackup()}>Open backup file</button>
              <button type="button" className="set-btn" onClick={copyBackup}>
                {copied ? "Copied" : "Copy backup"}
              </button>
              <button
                type="button"
                className="set-btn subtle"
                aria-expanded={restoreOpen}
                onClick={() => {
                  setRestoreOpen((o) => !o);
                  setRestoreError(undefined);
                }}
              >
                Restore…
              </button>
            </div>
          </Row>
          {backupMessage&&<p className="set-note" role="status">{backupMessage}</p>}
          <Row label="Recover previous snapshot" hint="Restore the previous successful save, including protected credentials. You can review the confirmation before replacing this workspace."><button className="set-btn" onClick={()=>void recover()}>Recover snapshot…</button></Row>
          {restoreOpen && (
            <div className="set-restore">
              <label className="set-restore-label" htmlFor="set-restore-text">
                Paste a backup, then restore. This replaces the current
                workspace; running agents are stopped after confirmation.
              </label>
              <textarea
                id="set-restore-text"
                className="set-restore-text mono"
                rows={4}
                spellCheck={false}
                value={restoreText}
                placeholder='{"cwd":"…","layout":[…]}'
                onChange={(e) => setRestoreText(e.target.value)}
              />
              {restoreError && (
                <p className="set-note bad">
                  <AlertTriangleIcon width={12} height={12} /> {restoreError}
                </p>
              )}
              <div className="set-key">
                <button
                  type="button"
                  className="set-btn"
                  disabled={!restoreText.trim()}
                  onClick={runRestore}
                >
                  Restore workspace
                </button>
                <button
                  type="button"
                  className="set-btn subtle"
                  onClick={() => setRestoreOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <Row
            label="Reset everything"
            hint="Clears the saved workspace — layout, agents, tasks, run history and these settings — and reloads with the defaults."
          >
            <ConfirmButton
              label="Reset workspace"
              confirmLabel="Click again to reset"
              icon={<TrashIcon width={13} height={13} />}
              onConfirm={onResetWorkspace}
            />
          </Row>
        </Section>
      </div>
    </div></SettingsFilter.Provider>
  );
}
