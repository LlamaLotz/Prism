import { resolveAgentApproval } from '../../services/agentApprovals';
import './study.css';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, History } from 'lucide-react';
import { knowledge, type AgentPending, type AgentOperation } from '../../services/knowledge';
import { StarGlow } from '../ui/StarGlow';
/**
 * Collapsible "Agent history" dropdown shared by the notebook chat and the AI
 * sidebar. Collapsed by default and opened only by the user. New pending
 * approvals or actionable operations pulse a short StarBorder glow so the
 * collapsed bar still announces fresh work. The expanded body is capped at half
 * of the chat view (`.agent-history` max-height) and scrolls inside that bound.
 */
export function AgentReview({onMessage,onVaultChanged}:{onMessage:(text:string)=>Promise<void>;onVaultChanged?:()=>void}) {
 const [pending,setPending]=useState<AgentPending[]>([]),[operations,setOperations]=useState<AgentOperation[]>([]),[stale,setStale]=useState<AgentPending|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [open,setOpen]=useState(false);
 const [glowKey,setGlowKey]=useState(0);
 const [glowing,setGlowing]=useState(false);
 const glowTimer=useRef<number|null>(null);
 const actionable=operations.filter(o=>o.undoAvailable||o.state.includes('recovery')).slice(0,10);
 // Fresh work only glows while the panel is collapsed; the panel itself never
 // opens on its own, so a manual collapse stays collapsed.
 const previous=useRef(new Set<string>());
 useEffect(()=>{
  const ids=new Set([...pending.map(p=>p.id),...actionable.map(o=>o.id)]);
  const fresh=[...ids].some(id=>!previous.current.has(id));
  previous.current=ids;
  if(!fresh||open)return;
  setGlowKey(value=>value+1);
  setGlowing(true);
  if(glowTimer.current!==null)window.clearTimeout(glowTimer.current);
  glowTimer.current=window.setTimeout(()=>{setGlowing(false);glowTimer.current=null;},1800);
 },[pending,actionable,open]);
 useEffect(()=>()=>{if(glowTimer.current!==null)window.clearTimeout(glowTimer.current);},[]);
 const refresh=async()=>{const [p,o]=await Promise.all([knowledge.agentPending(),knowledge.agentOperations()]);setPending(p);setOperations(o);};
 useEffect(()=>{let alive=true;const poll=async()=>{try{const [p,o]=await Promise.all([knowledge.agentPending(),knowledge.agentOperations()]);if(alive){setPending(p);setOperations(o);}}catch(e){if(alive)setError(String(e));}};void poll();const timer=setInterval(()=>void poll(),1500);return()=>{alive=false;clearInterval(timer);};},[]);
 const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError(String(e));}finally{setBusy(false);}};
 const counts=pending.length?`${pending.length} pending approval${pending.length===1?'':'s'}`:actionable.length?`${actionable.length} to review`:'Nothing to review';
 return <div className="agent-history" data-open={open?'true':undefined}>
  {glowing&&<div key={glowKey} className="agent-history-glow" aria-hidden="true"><StarGlow/></div>}
  <button type="button" className="agent-history-toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
   <History size={14}/><span>Agent history</span><span className="agent-history-counts">{counts}</span>
   {open?<ChevronDown size={14}/>:<ChevronUp size={14}/>}
  </button>
  {open&&<div className="study-agent-review agent-review agent-history-body" role="region" aria-label="Agent history panel">
   {error&&<p role="alert">{error}</p>}
   {!!pending.length&&<h3>Pending approval</h3>}
   {pending.map(p=><article key={p.id}><strong>{p.tool.replaceAll('_',' ')}</strong><small>{p.notePath}</small><pre>{p.preview||'(no preview)'}</pre><div className="study-toolbar"><button className="runtime-button" disabled={busy} onClick={()=>void run(async()=>{try{await resolveAgentApproval(p.id,true);}catch(e){if(String(e).includes('CONFLICT:')){setStale(p);setPending(rows=>rows.filter(r=>r.id!==p.id));}throw e;}onVaultChanged?.();await onMessage(`Approved \`${p.tool}\`.`);})}>Approve</button><button className="runtime-button" disabled={busy} onClick={()=>void run(async()=>{await resolveAgentApproval(p.id,false);await onMessage(`Denied \`${p.tool}\`.`);})}>Deny</button></div></article>)}
   {stale&&<article role="alert"><p>The source changed. Generate and review a fresh preview.</p><button className="runtime-button" disabled={busy} onClick={()=>void run(async()=>{await knowledge.agentCall(stale.tool,stale.input);setStale(null);})}>Generate fresh preview</button></article>}
   <div className="agent-operation-list" aria-label="Agent operation history">{actionable.map(o=><article key={o.id}><small>{o.tool.replaceAll('_',' ')} · {o.notePath}</small>{o.undoAvailable?<button className="runtime-button" disabled={busy} onClick={()=>void run(async()=>{const result=await knowledge.agentUndoOperation(o.id);onVaultChanged?.();await onMessage(`Undid operation on ${result.relativePath}.`);})}>Undo operation</button>:<><p role="alert">Recovery required: {o.error}</p><button className="runtime-button" disabled={busy} onClick={()=>void run(async()=>{await knowledge.agentRecheckOperation(o.id);onVaultChanged?.();})}>Recheck recovery</button></>}</article>)}</div>
   {!pending.length&&!stale&&!actionable.length&&!error&&<p className="study-muted">No agent operations yet. Tool results and approvals will collect here.</p>}
  </div>}
 </div>;
}
