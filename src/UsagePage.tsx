import { useEffect, useState } from "react";
import {
  RunRecord,
  aggregateUsage,
  formatDuration,
  runDuration,
} from "./usage";
import { AgentConfig } from "./agents";
import { Project } from "./workspace";
import { SearchIcon } from "./icons";
interface Props {
  runs: RunRecord[];
  agents: AgentConfig[];
  projects: Project[];
  onOpen: (id: string) => void;
}
export default function UsagePage({ runs, agents, projects, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [outcome, setOutcome] = useState("");
  const [days, setDays] = useState(0);
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!runs.some((r) => r.outcome === "running")) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runs]);
  const visible = runs.filter(
    (r) =>
      (!agent || r.agentId === agent) &&
      (!project || r.projectId === project) &&
      (!outcome || r.outcome === outcome) &&
      (!days ||
        r.startedAt > now - days * 86400000 ||
        r.outcome === "running") &&
      `${r.taskTitle ?? ""} ${r.session} ${r.agentName} ${r.cwd ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const summaries = aggregateUsage(visible, agents, now);
  const count = Math.max(1, Math.ceil(visible.length / 30));
  const current = Math.min(page, count - 1);
  const rows = [...visible].reverse().slice(current * 30, (current + 1) * 30);
  return (
    <div className="activity-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">YOUR WORK, RECORDED</p>
          <h1>Activity</h1>
          <p>Every attempt, its result, and the context to pick it up again.</p>
        </div>
        <span className="muted">{runs.length} saved runs</span>
      </header>
      <div className="activity-stats">
        <div>
          <span>Runs</span>
          <strong>{visible.length}</strong>
        </div>
        <div>
          <span>Live now</span>
          <strong>
            {visible.filter((r) => r.outcome === "running").length}
          </strong>
        </div>
        <div>
          <span>Session time</span>
          <strong>
            {formatDuration(summaries.reduce((n, s) => n + s.totalMs, 0))}
          </strong>
        </div>
        <div>
          <span>Failed</span>
          <strong>{summaries.reduce((n, s) => n + s.failed, 0)}</strong>
        </div>
      </div>
      <div className="activity-filters">
        <label className="search-field">
          <SearchIcon />
          <input
            value={query}
            aria-label="Search run history"
            placeholder="Search runs…"
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <select
          aria-label="Filter history by project"
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter history by agent"
          value={agent}
          onChange={(e) => {
            setAgent(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter history by outcome"
          value={outcome}
          onChange={(e) => {
            setOutcome(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All outcomes</option>
          {["running", "completed", "stopped", "interrupted", "failed"].map(
            (o) => (
              <option key={o}>{o}</option>
            ),
          )}
        </select>
        <select
          aria-label="History time range"
          value={days}
          onChange={(e) => {
            setDays(Number(e.target.value));
            setPage(0);
          }}
        >
          <option value={0}>All time</option>
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>
      {rows.length ? (
        <div className="activity-table-wrap">
          <table className="activity-table">
            <thead>
              <tr>
                <th>Task / session</th>
                <th>Agent</th>
                <th>Project</th>
                <th>Result</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const duration = runDuration(r, now);
                return (
                  <tr key={r.id}>
                    <td>
                      <button
                        className="history-link"
                        onClick={() => onOpen(r.id)}
                      >
                        {r.taskTitle || r.session}
                      </button>
                      <small>
                        {r.mode === "headless"
                          ? "Run to completion"
                          : "Interactive"}
                      </small>
                    </td>
                    <td>
                      {r.agentName}
                      <small>{r.model || "CLI default"}</small>
                    </td>
                    <td>
                      {projects.find((p) => p.id === r.projectId)?.name ||
                        "Earlier workspace"}
                    </td>
                    <td>
                      <span className={`outcome ${r.outcome}`}>
                        {r.outcome === "completed"
                          ? r.exitCode === 0
                            ? "Exit 0"
                            : r.exitCode === undefined
                              ? "Exited"
                              : `Exit ${r.exitCode}`
                          : r.outcome}
                      </span>
                    </td>
                    <td>
                      {duration === undefined ? "—" : formatDuration(duration)}
                    </td>
                    <td>{new Date(r.startedAt).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="activity-empty">
          <h2>
            {runs.length ? "No matching runs" : "Your work will appear here"}
          </h2>
          <p>
            {runs.length
              ? "Adjust the filters to find an earlier attempt."
              : "Start a task or a session. Its request, saved output, and changed files will be available here."}
          </p>
        </div>
      )}
      <div className="pagination">
        <span>
          {visible.length} matching runs · Page {current + 1} of {count}
        </span>
        <button
          className="btn"
          disabled={current === 0}
          onClick={() => setPage(current - 1)}
        >
          Previous
        </button>
        <button
          className="btn"
          disabled={current + 1 >= count}
          onClick={() => setPage(current + 1)}
        >
          Next
        </button>
      </div>
      <p className="muted usage-footnote">
        Session time measures elapsed runtime. Tokens, cost, and account quotas
        are unavailable unless reported by the CLI; no estimates are inferred
        from duration.
      </p>
    </div>
  );
}
