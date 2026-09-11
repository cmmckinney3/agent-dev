import ReactDOM from "react-dom/client";
import App from "./App";
import { loadWorkspace } from "./storage";
import RecoveryScreen from "./RecoveryScreen";
import "./App.css";
import "./Premium.css";
const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);
root.render(
  <div className="startup-screen">
    <h1>Crucible</h1>
    <p>Opening your workspace…</p>
  </div>,
);
loadWorkspace()
  .then(({ workspace, warning }) =>
    root.render(<App initial={workspace} warning={warning} />),
  )
  .catch(error => root.render(<RecoveryScreen error={String(error)} onOpen={workspace=>root.render(<App initial={workspace} warning="Opened recovered workspace."/>)} />));
