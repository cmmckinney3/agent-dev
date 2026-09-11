import { useEffect, useState } from "react";
import Modal from "./Modal";
import { SearchIcon } from "./icons";
export interface PaletteAction {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  run: () => void;
}
export default function CommandPalette({
  actions,
  onClose,
}: {
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  useEffect(() => { document.getElementById(`command-${selected}`)?.scrollIntoView({block:"nearest"}); }, [selected, query]);
  const results = actions
    .filter((a) =>
      `${a.label} ${a.detail ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice(0, 60);
  const choose = (action: PaletteAction) => {
    onClose();
    action.run();
  };
  return (
    <Modal title="Commands & search" onClose={onClose}>
      <div className="palette">
        <label className="palette-search">
          <SearchIcon />
          <input
            autoFocus
            role="combobox"
            aria-label="Search commands, projects, tasks, and runs"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={
              results[selected] ? `command-${selected}` : undefined
            }
            value={query}
            placeholder="Search commands, projects, tasks, runs…"
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setSelected(
                  (n) =>
                    (n + (e.key === "ArrowDown" ? 1 : -1) + results.length) %
                    Math.max(results.length, 1),
                );
              }
              if (e.key === "Enter" && results[selected])
                choose(results[selected]);
            }}
          />
        </label>
        <div className="palette-results" id="command-results" role="listbox">
          {results.map((a, i) => (
            <div
              id={`command-${i}`}
              role="option"
              aria-selected={selected === i}
              className={selected === i ? "selected" : ""}
              key={a.id}
            >
              <button tabIndex={-1} onClick={() => choose(a)}>
                <span>
                  {a.label}
                  <small>{a.detail}</small>
                </span>
                {a.shortcut && <kbd>{a.shortcut}</kbd>}
              </button>
            </div>
          ))}
          {!results.length && (
            <p className="empty-small">
              No matches. Try a project, task title, or command.
            </p>
          )}
        </div>
        <footer className="palette-help">
          ↑ ↓ to navigate · Enter to open · Esc to close
        </footer>
      </div>
    </Modal>
  );
}
