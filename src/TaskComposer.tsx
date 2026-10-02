import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Modal from "./Modal";
import { AgentConfig } from "./agents";
import { Task, TaskDraft, draftFromTask } from "./tasks";
import { Teammate } from "./teammates";
import { PromptTemplate } from "./workspace";
import { FolderIcon, PlayIcon } from "./icons";
export default function TaskComposer({
  task,
  agents,
  teammates,
  cwd,
  tasks,
  templates,
  onSave,
  onClose,
  onTemplate,
  initialDraft,
  onDraft,
}: {
  task?: Task;
  agents: AgentConfig[];
  teammates: Teammate[];
  cwd: string;
  tasks: Task[];
  templates: PromptTemplate[];
  onSave: (draft: TaskDraft, run: boolean) => void;
  onClose: () => void;
  onTemplate: (name: string, draft: TaskDraft) => void;
  initialDraft?: TaskDraft;
  onDraft: (draft: TaskDraft) => void;
}) {
  const [draft, setDraft] = useState<TaskDraft>(
    task || initialDraft
      ? draftFromTask(task ?? initialDraft!)
      : {
          title: "",
          prompt: "",
          agentId: agents[0].id,
          mode: "interactive",
          priority: "normal",
          dependencies: [],
          isolation: false,
        },
  );
  const [error, setError] = useState("");
  const [templateName, setTemplateName] = useState("");
  const updateDraft = (next: TaskDraft) => {
    setDraft(next);
    if (!task) onDraft(next);
  };
  const patch = (change: Partial<TaskDraft>) =>
    updateDraft({ ...draft, ...change });
  const save = (run: boolean) => {
    if (!draft.prompt.trim()) {
      setError("Describe what you want the agent to do.");
      return;
    }
    onSave(
      {
        ...draftFromTask(draft),
        title:
          draft.title.trim() || draft.prompt.trim().split("\n")[0].slice(0, 80),
        prompt: draft.prompt.trim(),
      },
      run,
    );
  };
  const browse = async () => {
    try {
      const path = await open({
        directory: true,
        multiple: false,
        title: "Task folder",
      });
      if (typeof path === "string") patch({ cwd: path });
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Modal title={task ? "Edit task" : "New task"} onClose={onClose} wide>
      <form
        className="task-composer"
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
      >
        {templates.length > 0 && !task && (
          <label>
            Start from a template
            <select
              defaultValue=""
              onChange={(e) => {
                const t = templates.find((t) => t.id === e.target.value);
                if (t) updateDraft(draftFromTask(t.draft));
              }}
            >
              <option value="">Choose template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Task title
          <input
            autoFocus
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="What are we working on?"
          />
        </label>
        <label>
          Instructions
          <textarea
            className="task-instructions"
            rows={9}
            value={draft.prompt}
            onChange={(e) => patch({ prompt: e.target.value })}
            placeholder="Describe the outcome, useful context, and how to check the result…"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                save(false);
              }
            }}
          />
        </label>
        <div className="form-grid">
          <label>
            Who does it
            <select
              value={
                draft.teammateId
                  ? `teammate:${draft.teammateId}`
                  : draft.agentId
              }
              onChange={(e) => {
                const mate = teammates.find(
                  (t) => `teammate:${t.id}` === e.target.value,
                );
                // A teammate brings its own engine; an agent clears the teammate.
                if (mate) patch({ teammateId: mate.id, agentId: mate.agentId });
                else patch({ agentId: e.target.value, teammateId: undefined });
              }}
            >
              {teammates.length > 0 && (
                <optgroup label="Teammates">
                  {teammates.map((t) => (
                    <option key={t.id} value={`teammate:${t.id}`}>
                      {t.name} ·{" "}
                      {agents.find((a) => a.id === t.agentId)?.name ??
                        "engine off"}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Agents">
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            Run mode
            <select
              value={draft.mode}
              onChange={(e) => patch({ mode: e.target.value as Task["mode"] })}
            >
              <option value="interactive">
                Interactive · steer as it works
              </option>
              <option value="headless">
                Run to completion · review the result
              </option>
            </select>
          </label>
          <label>
            Priority
            <select
              value={draft.priority ?? "normal"}
              onChange={(e) =>
                patch({ priority: e.target.value as Task["priority"] })
              }
            >
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </label>
        </div>
        <div className="launch-context">
          <FolderIcon />
          <span>
            {draft.cwd || cwd || "Choose a project folder before launching"}
          </span>
          <button className="text-button" type="button" onClick={browse}>
            Change
          </button>
          {draft.cwd && (
            <button
              className="text-button"
              type="button"
              onClick={() => patch({ cwd: undefined })}
            >
              Use project
            </button>
          )}
        </div>
        <details className="advanced">
          <summary>Dependencies, isolation, and templates</summary>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.isolation ?? false}
              onChange={(e) => patch({ isolation: e.target.checked })}
            />
            Run in a separate Git worktree
          </label>
          <p className="muted">
            Creates a branch from committed HEAD. Uncommitted changes in the
            project are not copied. Worktrees remain available for review.
          </p>
          <fieldset>
            <legend>Start after these tasks are done</legend>
            {tasks
              .filter((t) => t.id !== task?.id && !t.archived)
              .map((t) => (
                <label className="check-row" key={t.id}>
                  <input
                    type="checkbox"
                    checked={draft.dependencies?.includes(t.id) ?? false}
                    onChange={(e) =>
                      patch({
                        dependencies: e.target.checked
                          ? [...(draft.dependencies ?? []), t.id]
                          : (draft.dependencies ?? []).filter(
                              (id) => id !== t.id,
                            ),
                      })
                    }
                  />
                  {t.title}
                </label>
              ))}
            {tasks.length === 0 && (
              <p className="muted">No other tasks in this project yet.</p>
            )}
          </fieldset>
          <div className="template-save">
            <input
              aria-label="Template name"
              placeholder="Template name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              disabled={!templateName.trim() || !draft.prompt.trim()}
              onClick={() => {
                onTemplate(templateName.trim(), draftFromTask(draft));
                setTemplateName("");
              }}
            >
              Save template
            </button>
          </div>
        </details>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-actions">
          <span className="muted">Ctrl+Enter to save</span>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit">
            {task ? "Save changes" : "Add to backlog"}
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!draft.prompt.trim()}
            onClick={() => save(true)}
          >
            <PlayIcon />
            Save & run
          </button>
        </footer>
      </form>
    </Modal>
  );
}
