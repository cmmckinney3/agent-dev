import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { RunRecord, formatDuration, runDuration } from "./usage";
import { plainOutput } from "./review";
import { FolderIcon, RestartIcon } from "./icons";
export interface ReviewData {
  output: string;
  truncated: boolean;
  review: {
    git: boolean;
    warnings: string[];
    files: { path: string; status: string; diff: string }[];
  };
}
export default function RunReview({
  run,
  onRerun,
  onResume,
  onUpdate,
}: {
  run: RunRecord;
  onRerun?: () => void;
  onResume?: (sessionId: string) => void;
  onUpdate?: (patch: Partial<RunRecord>) => void;
}) {
  const [data, setData] = useState<ReviewData>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"output" | "files" | "request">("output");
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [resumeId, setResumeId] = useState(run.resumeId ?? "");
  useEffect(() => {
    let valid = true;
    setLoading(true);
    setError("");
    setData(undefined);
    invoke<ReviewData>("read_run", {
      runId: run.id,
      refresh: refresh > 0 && run.outcome === "running",
    })
      .then((d) => {
        if (valid) {
          setData(d);
          setSelected(d.review.files[0]?.path ?? "");
        }
      })
      .catch((e) => {
        if (valid) setError(String(e));
      })
      .finally(() => {
        if (valid) setLoading(false);
      });
    return () => {
      valid = false;
    };
  }, [run.id, run.outcome, refresh]);
  const duration = runDuration(run, Date.now());
  const output = data ? plainOutput(data.output) : "";
  const lines = query
    ? output
        .split("\n")
        .filter((line) => line.toLowerCase().includes(query.toLowerCase()))
        .join("\n")
    : output;
  const file = data?.review.files.find((f) => f.path === selected);
  return (
    <div className="run-review">
      <div className="run-summary">
        <span className={`outcome ${run.outcome}`}>
          {run.outcome === "failed" ? "Failed to start" : run.outcome}
        </span>
        <span>
          {run.agentName} · {run.model || "CLI default model"}
        </span>
        <span>
          {duration === undefined
            ? "Duration unavailable"
            : formatDuration(duration)}
        </span>
        <time>{new Date(run.startedAt).toLocaleString()}</time>
      </div>
      {run.error && <p className="error-text">{run.error}</p>}
      <div className="launch-context">
        <FolderIcon />
        <span>
          {run.cwd || "Directory was not recorded for this older run"}
        </span>
        {run.cwd && (
          <button
            className="text-button"
            onClick={() =>
              void openPath(run.cwd!).catch((e) => setError(String(e)))
            }
          >
            Open folder
          </button>
        )}
      </div>
      <div className="review-tabs" role="tablist" aria-label="Run details">
        {(["output", "files", "request"] as const).map((t) => (
          <button
            role="tab"
            aria-selected={tab === t}
            key={t}
            onClick={() => setTab(t)}
          >
            {t === "output"
              ? "Saved output"
              : t === "files"
                ? `Changed files${data ? ` (${data.review.files.length})` : ""}`
                : "Original request"}
          </button>
        ))}
        <button
          className="text-button"
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh
        </button>
      </div>
      {tab === "request" ? <pre className="request-view">{run.prompt || "This session was started manually. No seeded request was recorded."}</pre> : loading ? (
        <p className="empty-small" role="status">
          Loading saved run…
        </p>
      ) : error ? (
        <p className="error-text" role="alert">
          {error}
          <br />
          Older runs created before output recording may not have a saved
          transcript.
        </p>
      ) : (
        <>
          {tab === "output" && (
            <>
              <div className="output-tools">
                <input
                  aria-label="Search saved output"
                  placeholder="Filter output lines…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  className="text-button"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(output)
                      .catch((e) => setError(String(e)))
                  }
                >
                  Copy output
                </button>
              </div>
              {data?.truncated && (
                <p className="notice-inline">
                  Output reached the 8 MiB recording limit.
                </p>
              )}
              {lines.length > 300000 && (
                <p className="notice-inline">
                  Showing the last 300,000 characters. Copy output includes the
                  full recording.
                </p>
              )}
              <pre className="output-view" tabIndex={0}>
                {lines.slice(-300000) || "No matching output."}
              </pre>
            </>
          )}
          {tab === "files" && (
            <>
              <p className="muted">
                Changes compared with the snapshot immediately before this run.
                Other processes editing this folder may also contribute changes;
                use an isolated worktree for attribution.
              </p>
              {data?.review.warnings.map((w) => (
                <p key={w} className="notice-inline">
                  {w}
                </p>
              ))}
              {data?.review.files.length ? (
                <div className="diff-browser">
                  <nav aria-label="Changed files">
                    {data.review.files.map((f) => (
                      <button
                        className={selected === f.path ? "selected" : ""}
                        key={f.path}
                        onClick={() => setSelected(f.path)}
                      >
                        <span className={`file-status ${f.status}`}>
                          {f.status.slice(0, 1).toUpperCase()}
                        </span>
                        {f.path}
                      </button>
                    ))}
                  </nav>
                  <pre className="diff-view" tabIndex={0}>
                    {file?.diff.split("\n").map((line, i) => (
                      <span
                        key={i}
                        className={
                          line.startsWith("+")
                            ? "diff-add"
                            : line.startsWith("-")
                              ? "diff-remove"
                              : line.startsWith("@@")
                                ? "diff-context"
                                : ""
                        }
                      >
                        {line}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                </div>
              ) : (
                <p className="empty-small">
                  No text-file changes were captured for this run.
                </p>
              )}
            </>
          )}
        </>
      )}
      {run.outcome !== "running" && (
        <div className="run-followup">
          {onRerun && (
            <button className="btn" onClick={onRerun}>
              <RestartIcon />
              Start a new run
            </button>
          )}
          {onResume && (
            <details className="advanced">
              <summary>Resume a CLI session</summary>
              <p className="muted">
                Use the session ID supplied by the CLI. A saved output log alone
                cannot resume a process.
              </p>
              <div className="template-save">
                <input
                  aria-label="CLI session ID"
                  placeholder="Session ID"
                  value={resumeId}
                  onChange={(e) => setResumeId(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={!/^[a-zA-Z0-9_-]+$/.test(resumeId)}
                  onClick={() => {
                    onUpdate?.({ resumeId });
                    onResume(resumeId);
                  }}
                >
                  Resume session
                </button>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
