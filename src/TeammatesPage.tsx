import { useEffect, useState } from "react";
import { AgentConfig } from "./agents";
import { Task } from "./tasks";
import {
  BRIEF_MAX,
  MEMORY_DIR,
  MEMORY_MAX,
  NAME_MAX,
  Teammate,
  teammateNameError,
} from "./teammates";
import { RunRecord } from "./usage";
import { PlusIcon, TeammatesIcon } from "./icons";

interface Props {
  teammates: Teammate[];
  agents: AgentConfig[];
  tasks: Task[];
  runs: RunRecord[];
  /** Show this teammate when the page opens (from a toast or task detail). */
  focus?: string;
  onAdd: () => string;
  onUpdate: (id: string, patch: Partial<Teammate>) => void;
  onDelete: (id: string) => void;
  onOpenTask: (id: string) => void;
}

/** "1 note", "3 notes": a note is a non-empty line. */
const notes = (memory: string) => {
  const n = memory.split("\n").filter((line) => line.trim()).length;
  return `${n} note${n === 1 ? "" : "s"}`;
};

/** Saved agents: who they are, what they own, and what they remember. */
export default function TeammatesPage(p: Props) {
  const [selected, setSelected] = useState(p.focus ?? p.teammates[0]?.id);
  useEffect(() => {
    if (p.focus) setSelected(p.focus);
  }, [p.focus]);
  const mate = p.teammates.find((t) => t.id === selected) ?? p.teammates[0];
  // The name is edited locally so an invalid one can be shown, not stored.
  const [name, setName] = useState(mate?.name ?? "");
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    setName(mate?.name ?? "");
    setClearing(false);
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
  const add = () => setSelected(p.onAdd());
  return (
    <div className="activity-page teammates-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">AGENTS THAT REMEMBER</p>
          <h1>Teammates</h1>
          <p>
            Saved agents with a brief and a memory that follows them from
            project to project.
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
            next.
          </p>
          <button className="btn primary" onClick={add}>
            <PlusIcon />
            Create a teammate
          </button>
        </div>
      ) : (
        <div className="teammates-layout">
          <nav className="teammate-list" aria-label="Teammates">
            {p.teammates.map((t) => (
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
                    {engine(t.agentId)?.name ?? "No engine"} · {notes(t.memory)}
                  </small>
                </span>
              </button>
            ))}
          </nav>
          <section className="teammate-editor" aria-label={`${mate.name}`}>
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
                      !teammateNameError(e.target.value, p.teammates, mate.id)
                    )
                      p.onUpdate(mate.id, { name: e.target.value.trim() });
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
                rows={5}
                maxLength={BRIEF_MAX}
                value={mate.brief}
                placeholder="What does this teammate own? What standards apply? When should it stop and ask?"
                onChange={(e) => p.onUpdate(mate.id, { brief: e.target.value })}
              />
            </label>
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
                rows={12}
                maxLength={MEMORY_MAX}
                value={mate.memory}
                placeholder="Empty. As it works, the teammate adds notes here: preferences, decisions, conventions, pitfalls."
                onChange={(e) =>
                  p.onUpdate(mate.id, { memory: e.target.value })
                }
              />
              <p className="muted">
                Each run gets this as a file in its folder ({MEMORY_DIR}, kept
                out of Git) and Crucible reads it back when the run ends. Edit
                or prune it freely. Never put secrets here.
              </p>
            </div>
            <div className="teammate-block">
              <h3>Recent work</h3>
              {recent.length ? (
                <ul className="review-links">
                  {recent.map((r) => (
                    <li key={r.id}>
                      <span className={`outcome ${r.outcome}`}>
                        {r.outcome}
                      </span>
                      {r.taskId && p.tasks.some((t) => t.id === r.taskId) ? (
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
