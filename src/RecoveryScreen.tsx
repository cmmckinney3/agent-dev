import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { normalizeWorkspace, Workspace } from "./workspace";
import { parseBackup } from "./storage";

export default function RecoveryScreen({error,onOpen}:{error:string;onOpen:(workspace:Workspace)=>void}) {
  const [message,setMessage]=useState(error);
  const [busy,setBusy]=useState(false);
  const recover=async(fromFile:boolean)=>{
    setBusy(true);
    try {
      let workspace:Workspace;
      if(fromFile){const contents=await invoke<string|null>("import_backup");if(!contents)return;workspace=parseBackup(contents);}
      else {const result=await invoke<{workspace:unknown}>("load_workspace",{recovery:true});workspace=normalizeWorkspace(result.workspace,true);}
      await invoke("save_workspace",{workspace});onOpen(workspace);
    } catch(e) {setMessage(String(e));} finally {setBusy(false);}
  };
  return <div className="startup-screen"><h1>Your workspace needs attention</h1><p role="alert">{message}</p><p>Your existing data is preserved. Open the previous snapshot or choose a workspace backup.</p><div className="detail-actions"><button className="btn" disabled={busy} onClick={()=>void recover(false)}>Open recovery snapshot</button><button className="btn" disabled={busy} onClick={()=>void recover(true)}>Restore backup file</button><button className="btn" disabled={busy} onClick={()=>location.reload()}>Try again</button></div></div>;
}
