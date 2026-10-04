import { useEffect, useState } from "react";
import { AgentConfig } from "./agents";
import { BODY_MAX, OWNER, TeamMessage, waitingFor } from "./messages";
import { Task } from "./tasks";
import {
  BRIEF_MAX,
  CRUCIBLE_DIR,
  MEMORY_MAX,
  NAME_MAX,
  OnMessage,
  Teammate,
  teammateNameError,
} from "./teammates";
import { RunRecord } from "./usage";
import { PlusIcon, SendIcon, TeammatesIcon } from "./icons";

export type TeammateTab = "profile" | "memory" | "messages" | "work";
/** Open the page on a teammate (and tab); `n` makes a repeat request count. */
export interface TeammateFocus {
  id?: string;
  tab?: TeammateTab;
  n: number;
}

interface Props {
  teammates: Teammate[];
  agents: AgentConfig[];
  tasks: Task[];
  runs: RunRecord[];
  messages: TeamMessage[];
  projects: { id: string; name: string }[];
  focus?: TeammateFocus;
  onAdd: () => string;
  onUpdate: (id: string, patch: Partial<Teammate>) => void;
  onDelete: (id: string) => void;
  onOpenTask: (id: string) => void;
  onSend: (to: string, body: string) => void;
  onStartMessage: (id: string) => void;
  onDeleteMessage: (id: string) => void;
}

/** "1 note", "3 notes": a note is a non-empty line. */
const notes = (memory: string) => {
  const n = memory.split("\n").filter((line) => line.trim()).length;
  return `${n} note${n === 1 ? "" : "s"}`;
};
/** Messages shown before "Show older". */
const SHOWN = 20;
/** A body longer than this many lines starts folded. */
const FOLD_LINES = 6;

const ON_MESSAGE: { id: OnMessage; label: string; hint: string }[] = [
  {
    id: "hold",
    label: "Hold it for the next task",
    hint: "Messages wait in the inbox and are delivered with the next task you give this teammate.",
  },
  {
    id: "start",
    label: "Start a task to handle it",
    hint: "A message starts a headless task in the sender's folder, unless Settings pauses this or the chain of messages is at its limit.",
  },
];

/** Saved agents: who they are, what they own, and what they remember. */
export default function TeammatesPage(p: Props) {
  const [selected, setSelected] = useState(p.focus?.id ?? p.teammates[0]?.id);
  const [tab, setTab] = useState<TeammateTab>(p.focus?.tab ?? "profile");
  useEffect(() => {
    if (p.focus?.id) setSelected(p.focus.id);
    if (p.focus?.tab) setTab(p.focus.tab);
  }, [p.focus]);
  const mate = p.teammates.find((t) => t.id === selected) ?? p.teammates[0];
  // The name is edited locally so an invalid one can be shown, not stored.
  const [name, setName] = useState(mate?.name ?? "");
  const [clearing, setClearing] = useState(false);
  const [draft, setDraft] = useState("");
  const [older, setOlder] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setName(mate?.name ?? "");
    setClearing(false);
    setDraft("");
    setOlder(false);
  }, [mate?.id]);
  const nameError = mate
    ? teammateNameError(name, p.teammates, mate.id)
    : undefined;
  const engine = (id: string) => p.agents.find((a) => a.id === id);
  const recent = mate
    ? p.runs
        .filter((r) => r.teammateId === mate.id)
        .slice(-6)
        .reverse()
    : [];
  const thread = mate
    ? p.messages.filter((m) => m.to === mate.id || m.from === mate.id).reverse()
    : [];
  const shown = older ? thread : thread.slice(0, SHOWN);
  const waiting = mate ? waitingFor(p.messages, mate.id) : 0;
  const nameOf = (id: string, fallback: string) =>
    id === OWNER
      ? "You"
      : (p.teammates.find((t) => t.id === id)?.name ?? fallback);
  const add = () => {
    setSelected(p.onAdd());
    setTab("profile");
  };
  const send = () => {
    if (!mate || !draft.trim()) return;
    p.onSend(mate.id, draft);
    setDraft("");
  };
  const tabs: { id: TeammateTab; label: string }[] = [
    { id: "profile", label: "Profile" },
    { id: "memory", label: mate ? `Memory · ${notes(mate.memory)}` : "Memory" },
    {
      id: "messages",
      label: waiting ? `Messages · ${waiting} waiting` : "Messages",
    },
    { id: "work", label: "Work" },
  ];
  return (
    <div className="activity-page teammates-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">AGENTS THAT REMEMBER</p>
          <h1>Teammates</h1>
          <p>
            Saved agents with a brief and a memory that follows them from
            project to project. They can message each other, too.
          </p>
        </div>
        <button className="btn primary" onClick={add}>
          <PlusIcon />
          New teammate
        </button>
      </header>
      {!mate ? (
        <div className="activity-empty">
          <TeammatesIcon width={28} height={28} />
          <h2>No teammates yet</h2>
          <p>
            A teammate is an agent with a name, a brief and its own memory.
            Assign it tasks in any project: it reads its notes before it starts
            and adds what it learns, so lessons carry from one project to the
            next. Teammates can also pass lessons and requests to each other.
          </p>
          <button className="btn primary" onClick={add}>
            <PlusIcon />
            Create a teammate
          </button>
        </div>
      ) : (
        <div className="teammates-layout">
          <nav className="teammate-list" aria-label="Teammates">
            {p.teammates.map((t) => {
              const count = waitingFor(p.messages, t.id);
              return (
                <button
                  key={t.id}
                  className={t.id === mate.id ? "selected" : ""}
                  aria-current={t.id === mate.id ? "true" : undefined}
                  onClick={() => setSelected(t.id)}
                >
                  <span
                    className="teammate-mark"
                    style={{ background: engine(t.agentId)?.accent }}
                    aria-hidden="true"
                  />
                  <span className="teammate-list-text">
                    <strong>{t.name}</strong>
                    <small>
                      {engine(t.agentId)?.name ?? "No engine"} ·{" "}
                      {notes(t.memory)}
                    </small>
                  </span>
                  {count > 0 && (
                    <b
                      className="count-badge"
                      title={`${count} message${count === 1 ? "" : "s"} waiting`}
                    >
                      {count}
                      <span className="sr-only"> waiting</span>
                    </b>
                  )}
                </button>
              );
            })}
          </nav>
          <section className="teammate-editor" aria-label={mate.name}>
            <div
              className="review-tabs"
              role="tablist"
              aria-label={`${mate.name}'s details`}
            >
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  id={`teammate-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls="teammate-tabpanel"
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div
              id="teammate-tabpanel"
              role="tabpanel"
              aria-labelledby={`teammate-tab-${tab}`}
            >
              {tab === "profile" && (
                <>
                  <div className="teammate-fields">
                    <label>
                      Name
                      <input
                        value={name}
                        maxLength={NAME_MAX}
                        aria-invalid={Boolean(nameError)}
                        aria-describedby={
                          nameError ? "teammate-name-error" : undefined
                        }
                        onChange={(e) => {
                          setName(e.target.value);
                          if (
                            !teammateNameError(
                              e.target.value,
                              p.teammates,
                              mate.id,
                            )
                          )
                            p.onUpdate(mate.id, {
                              name: e.target.value.trim(),
                            });
                        }}
                      />
                      {nameError && (
                        <span id="teammate-name-error" className="error-text">
                          {nameError}
                        </span>
                      )}
                    </label>
                    <label>
                      Engine
                      <select
                        value={mate.agentId}
                        onChange={(e) =>
                          p.onUpdate(mate.id, { agentId: e.target.value })
                        }
                      >
                        {p.agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                            {a.enabled ? "" : " (off)"}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="teammate-block">
                    <span className="teammate-label">
                      Brief
                      <small>
                        {mate.brief.length}/{BRIEF_MAX}
                      </small>
                    </span>
                    <textarea
                      rows={7}
                      maxLength={BRIEF_MAX}
                      value={mate.brief}
                      placeholder="What does this teammate own? What standards apply? When should it stop and ask?"
                      onChange={(e) =>
                        p.onUpdate(mate.id, { brief: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {tab === "memory" && (
                <div className="teammate-block">
                  <div className="teammate-label">
                    <label htmlFor="teammate-memory">Memory</label>
                    <small>
                      {notes(mate.memory)} · {mate.memory.length}/{MEMORY_MAX}
                      {mate.memoryUpdatedAt
                        ? ` · updated ${new Date(mate.memoryUpdatedAt).toLocaleString()}`
                        : ""}
                    </small>
                    <span className="spacer" />
                    {clearing ? (
                      <>
                        <span className="muted">Clear every note?</span>
                        <button
                          className="text-button danger-text"
                          onClick={() => {
                            p.onUpdate(mate.id, { memory: "" });
                            setClearing(false);
                          }}
                        >
                          Clear
                        </button>
                        <button
                          className="text-button"
                          onClick={() => setClearing(false)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        className="text-button"
                        disabled={!mate.memory}
                        onClick={() => setClearing(true)}
                      >
                        Clear memory
                      </button>
                    )}
                  </div>
                  <textarea
                    id="teammate-memory"
                    className="memory-editor"
                    spellCheck={false}
                    rows={14}
                    maxLength={MEMORY_MAX}
                    value={mate.memory}
                    placeholder="Empty. As it works, the teammate adds notes here: preferences, decisions, conventions, pitfalls."
                    onChange={(e) =>
                      p.onUpdate(mate.id, { memory: e.target.value })
                    }
                  />
                  <p className="muted">
                    Each run gets a copy in its own folder ({CRUCIBLE_DIR}, kept
                    out of Git), and Crucible reads it back and tidies up when
                    the run ends. Edit or prune it freely. Never put secrets
                    here. A headless run needs permission to edit files to keep
                    notes (for Codex, run it with{" "}
                    <code>-s workspace-write</code>
                    ).
                  </p>
                </div>
              )}
              {tab === "messages" && (
                <div className="teammate-block">
                  <div className="message-settings">
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={mate.canMessage}
                        onChange={(e) =>
                          p.onUpdate(mate.id, { canMessage: e.target.checked })
                        }
                      />
                      Can message other teammates
                    </label>
                    <label className="message-arrival">
                      When a message arrives
                      <select
                        value={mate.onMessage}
                        aria-describedby="teammate-arrival-hint"
                        onChange={(e) =>
                          p.onUpdate(mate.id, {
                            onMessage: e.target.value as OnMessage,
                          })
                        }
                      >
                        {ON_MESSAGE.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="muted" id="teammate-arrival-hint">
                      {ON_MESSAGE.find((o) => o.id === mate.onMessage)?.hint}
                    </p>
                  </div>
                  <form
                    className="message-compose"
                    onSubmit={(e) => {
                      e.preventDefault();
                      send();
                    }}
                  >
                    <textarea
                      aria-label={`Message to ${mate.name}`}
                      rows={2}
                      maxLength={BODY_MAX}
                      value={draft}
                      placeholder={`Write to ${mate.name}. It reads this with its next task.`}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          send();
                        }
                      }}
                    />
                    <button className="btn" disabled={!draft.trim()}>
                      <SendIcon />
                      Send
                    </button>
                  </form>
                  {thread.length ? (
                    <ul
                      className="message-list"
                      aria-label={`${mate.name}'s messages`}
                    >
                      {shown.map((m) => {
                        const pending = !m.deliveredAt;
                        const project = p.projects.find(
                          (x) => x.id === m.projectId,
                        )?.name;
                        // An archived task no longer handles it: offer a new one.
                        const task = m.taskId
                          ? p.tasks.find(
                              (t) => t.id === m.taskId && !t.archived,
                            )
                          : undefined;
                        const long =
                          m.body.split("\n").length > FOLD_LINES ||
                          m.body.length > 600;
                        const open = !long || unfolded.has(m.id);
                        const from = nameOf(m.from, m.fromName);
                        const to = nameOf(m.to, "a teammate");
                        return (
                          <li key={m.id} className={pending ? "waiting" : ""}>
                            <div className="message-head">
                              <strong>{from}</strong>
                              <span aria-label="to">→</span>
                              <strong>{to}</strong>
                              <span
                                className={`outcome ${pending ? "message-waiting" : "message-delivered"}`}
                              >
                                {pending ? "Waiting" : "Delivered"}
                              </span>
                              <time
                                className="muted"
                                dateTime={new Date(m.at).toISOString()}
                              >
                                {new Date(m.at).toLocaleString()}
                              </time>
                              {project && (
                                <span className="muted">{project}</span>
                              )}
                              <span className="spacer" />
                              {task ? (
                                <button
                                  className="text-button"
                                  onClick={() => p.onOpenTask(task.id)}
                                >
                                  Open task
                                </button>
                              ) : (
                                pending &&
                                m.to === mate.id && (
                                  <button
                                    className="text-button"
                                    onClick={() => p.onStartMessage(m.id)}
                                    title={`Start a headless task for ${to} to handle this message now`}
                                  >
                                    Start a task
                                  </button>
                                )
                              )}
                              <button
                                className="text-button"
                                aria-label={`Delete the message from ${from} to ${to}`}
                                onClick={() => p.onDeleteMessage(m.id)}
                              >
                                Delete
                              </button>
                            </div>
                            <pre
                              className={`message-body ${open ? "" : "folded"}`}
                            >
                              {m.body}
                            </pre>
                            {long && (
                              <button
                                className="text-button"
                                aria-expanded={open}
                                onClick={() =>
                                  setUnfolded((prev) => {
                                    const next = new Set(prev);
                                    if (open) next.delete(m.id);
                                    else next.add(m.id);
                                    return next;
                                  })
                                }
                              >
                                {open ? "Show less" : "Show all"}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="muted">
                      No messages yet.{" "}
                      {mate.canMessage
                        ? `During a task, ${mate.name} can write to the other teammates through its outbox, and they can write back.`
                        : `${mate.name} can receive messages but cannot send them.`}
                    </p>
                  )}
                  {thread.length > SHOWN && (
                    <button
                      className="text-button"
                      onClick={() => setOlder(!older)}
                    >
                      {older
                        ? "Show recent only"
                        : `Show older (${thread.length - SHOWN})`}
                    </button>
                  )}
                </div>
              )}
              {tab === "work" && (
                <div className="teammate-block">
                  <h3>Recent work</h3>
                  {recent.length ? (
                    <ul className="review-links">
                      {recent.map((r) => (
                        <li key={r.id}>
                          <span className={`outcome ${r.outcome}`}>
                            {r.outcome}
                          </span>
                          {r.taskId &&
                          p.tasks.some((t) => t.id === r.taskId) ? (
                            <button
                              className="text-button"
                              onClick={() => p.onOpenTask(r.taskId!)}
                            >
                              {r.taskTitle ?? r.session}
                            </button>
                          ) : (
                            <span>{r.taskTitle ?? r.session}</span>
                          )}
                          <time className="muted">
                            {new Date(r.startedAt).toLocaleString()}
                          </time>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">
                      No runs yet. Pick {mate.name} under “Who does it” when you
                      create a task.
                    </p>
                  )}
                </div>
              )}
            </div>
            <footer className="teammate-footer">
              <button
                className="text-button danger-text"
                onClick={() => p.onDelete(mate.id)}
              >
                Delete teammate
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
