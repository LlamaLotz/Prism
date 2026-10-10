import { useEffect, useRef, useState } from 'react';

/** Uses vault-relative paths; the empty path always means the vault root. */
export function FolderPicker({folders=[],value,onChange,label='Vault folder'}:{folders?:string[];value:string;onChange:(path:string)=>void;label?:string}) {
 const [query,setQuery]=useState('');
 const paths=Array.from(new Set(['',...folders])).sort((a,b)=>a.localeCompare(b));
 return <div className="runtime-settings"><label>{label}<input aria-label={`Search ${label.toLowerCase()}`} placeholder="Search folders…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
 <select aria-label={label} size={Math.min(6,Math.max(2,paths.length))} value={value} onChange={e=>onChange(e.target.value)}>
 {!paths.includes(value)&&<option value={value} disabled>{value} (unavailable)</option>}
 {paths.filter(p=>p===value||!p||p.toLowerCase().includes(query.toLowerCase())).map(p=><option key={p} value={p}>{p||'Vault root'}</option>)}
 </select></div>;
}
export function MoveNoteDialog({folders,initial,onMove,onClose}:{folders:string[];initial:string;onMove:(path:string)=>Promise<void>;onClose:()=>void}) {
 const ref=useRef<HTMLDialogElement>(null);const [path,setPath]=useState(initial);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 useEffect(()=>{const previous=document.activeElement as HTMLElement;ref.current?.showModal();return()=>{ref.current?.close();previous?.focus();};},[]);
 return <dialog ref={ref} className="runtime-dialog runtime-surface" onCancel={e=>{e.preventDefault();if(!busy)onClose();}} aria-label="Move note to folder"><h2>Move note to folder</h2><FolderPicker folders={folders} value={path} onChange={setPath}/>{error&&<p role="alert">{error}</p>}<div className="runtime-actions"><button disabled={busy} onClick={onClose}>Cancel</button><button disabled={busy||path===initial||!!path&&!folders.includes(path)} onClick={async()=>{setBusy(true);try{await onMove(path);onClose();}catch(e){setError(String(e));}finally{setBusy(false);}}}>Move note</button></div></dialog>;
}
