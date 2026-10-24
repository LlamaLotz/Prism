import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';

/** Uses vault-relative paths; the empty path always means the vault root. */
export function FolderPicker({folders=[],value,onChange,label='Vault folder'}:{folders?:string[];value:string;onChange:(path:string)=>void;label?:string}) {
  const [query,setQuery]=useState('');
  const paths=useMemo(()=>['',...Array.from(new Set(folders.filter(Boolean))).sort((a,b)=>a.localeCompare(b))],[folders]);
  const normalized=query.trim().toLowerCase();
  const matching=useMemo(()=>paths.filter(path=>path===''||path===value||path.toLowerCase().includes(normalized)),[paths,value,normalized]);
  const hasFolderMatch=normalized!==''&&paths.some(path=>path!==''&&path.toLowerCase().includes(normalized));
  const unavailable=!paths.includes(value);
  const id=useId();
  const listboxId=`${id}-listbox`;
  const [activeIndex,setActiveIndex]=useState(()=>Math.max(0,paths.indexOf(value)));
  const optionRefs=useRef<Array<HTMLDivElement|null>>([]);
  const active=activeIndex>=0&&activeIndex<matching.length?activeIndex:Math.max(0,matching.indexOf(value));
  const optionId=(index:number)=>`${id}-option-${index}`;

  useEffect(()=>{
    if(active<0)return;
    optionRefs.current[active]?.scrollIntoView({block:'nearest'});
  },[active,matching.length]);

  const choose=(path:string,index:number)=>{
    setActiveIndex(index);
    onChange(path);
  };
  const move=(delta:number)=>{
    if(!matching.length)return;
    setActiveIndex((active+delta+matching.length)%matching.length);
  };
  const onKeyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.key==='Escape'){
      if(!query)return;
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
      setActiveIndex(Math.max(0,paths.indexOf(value)));
      return;
    }
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();
      move(event.key==='ArrowDown'?1:-1);
      return;
    }
    if(event.key==='Home'||event.key==='End'){
      if(!matching.length)return;
      event.preventDefault();
      setActiveIndex(event.key==='Home'?0:matching.length-1);
      return;
    }
    if(event.key==='Enter'){
      const path=matching[active];
      if(path===undefined)return;
      event.preventDefault();
      choose(path,active);
    }
  };

  return <div className="runtime-settings folder-picker" onKeyDown={onKeyDown}>
    <label>{label}<input role="combobox" aria-label={`Search ${label.toLowerCase()}`} aria-expanded="true" aria-controls={listboxId} aria-autocomplete="list" aria-activedescendant={matching[active]===undefined?undefined:optionId(active)} placeholder="Search folders…" value={query} onChange={e=>{setQuery(e.target.value);setActiveIndex(0);}}/></label>
    <div id={listboxId} className="folder-picker-listbox" role="listbox" aria-label={label}>
      {unavailable&&<div className="folder-picker-option folder-picker-option-unavailable" role="option" aria-selected={true} aria-disabled="true">{value} (unavailable)</div>}
      {matching.map((path,index)=>{
        const selected=path===value;
        return <div key={path?`folder:${path}`:'vault-root'} ref={element=>{optionRefs.current[index]=element;}} className="folder-picker-option" role="option" aria-selected={selected} data-active={index===active} data-path={path} id={optionId(index)} onClick={()=>choose(path,index)} onMouseDown={event=>event.preventDefault()}>
          <span className="folder-picker-option-name">{path||'Vault root'}</span>
          {selected&&<Check className="folder-picker-check" size={14} aria-hidden="true"/>}
        </div>;
      })}
      {normalized!==''&&!hasFolderMatch&&<p className="folder-picker-empty">No folders match.</p>}
    </div>
  </div>;
}
export function MoveNoteDialog({folders,initial,onMove,onClose}:{folders:string[];initial:string;onMove:(path:string)=>Promise<void>;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null);const [path,setPath]=useState(initial);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{const previous=document.activeElement as HTMLElement;ref.current?.showModal();return()=>{ref.current?.close();previous?.focus();};},[]);
  return <dialog ref={ref} className="runtime-dialog runtime-surface" onCancel={e=>{e.preventDefault();if(!busy)onClose();}} aria-label="Move note to folder" aria-busy={busy}><h2>Move note to folder</h2><FolderPicker folders={folders} value={path} onChange={setPath}/>{error&&<p className="runtime-error" role="alert">{error}</p>}<div className="runtime-actions"><button type="button" className="runtime-button" disabled={busy} onClick={onClose}>Cancel</button><button type="button" className="runtime-button runtime-primary" disabled={busy||path===initial||!!path&&!folders.includes(path)} onClick={async()=>{setBusy(true);try{await onMove(path);onClose();}catch(e){setError(String(e));}finally{setBusy(false);}}}>Move note</button></div></dialog>;
}
