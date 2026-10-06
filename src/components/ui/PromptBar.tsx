import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, ShieldCheck, Square } from 'lucide-react';
import { ModelPicker, type ModelPickerOption } from './ModelPicker';
import './PromptBar.css';
import { useAccentContrast } from './useAccentContrast';
import './notebook-tokens.css';
export interface PromptModel { value: string; options: ModelPickerOption[]; onChange: (value: string) => void | Promise<unknown> }
/** Adapters own dispatch and persistence; this component owns input interaction. */
export function PromptBar({value,onChange,onSend,onStop,running=false,disabled=false,label='Message',placeholder='Ask about your sources…',model,context,onContext,agent,onAgent,extra}: {
 value:string;onChange:(value:string)=>void;onSend:()=>void|Promise<unknown>;onStop?:()=>void|Promise<unknown>;running?:boolean;disabled?:boolean;label?:string;placeholder?:string;model?:PromptModel;context?:ReactNode;onContext?:()=>void;agent?:boolean;onAgent?:(enabled:boolean)=>void;extra?:ReactNode;
}) {
 useAccentContrast();
 const input=useRef<HTMLTextAreaElement>(null);const dispatching=useRef(false);const [error,setError]=useState('');
 useLayoutEffect(()=>{const el=input.current;if(el){el.style.height='0px';el.style.height=`${Math.min(120,Math.max(24,el.scrollHeight))}px`;}},[value]);
 const send=async()=>{if(dispatching.current||running||disabled||!value.trim())return;dispatching.current=true;setError('');try{await onSend();}catch(e){setError(String(e));}finally{dispatching.current=false;}};
 return <form className="prompt-bar" onSubmit={e=>{e.preventDefault();void send();}}>
  <textarea ref={input} rows={1} aria-label={label} value={value} placeholder={placeholder} onChange={e=>onChange(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>
  <div className="prompt-bar__controls">{model&&<ModelPicker {...model} label="Chat model"/>}{context&&(onContext?<button type="button" onClick={onContext}>{context}</button>:<span className="prompt-bar__context">{context}</span>)}{extra}{onAgent&&<button type="button" aria-pressed={agent} disabled={running} onClick={()=>onAgent(!agent)}><ShieldCheck size={14}/> Agent {agent?'ON':'OFF'}</button>}<span className="prompt-bar__spacer"/>{running&&onStop?<button type="button" className="prompt-bar__send" aria-label="Cancel response" onClick={()=>{void Promise.resolve(onStop()).catch(e=>setError(String(e)));}}><Square size={17}/></button>:<button type="submit" className="prompt-bar__send" aria-label="Send" disabled={running||disabled||!value.trim()}><ArrowUp size={18}/></button>}</div>
  {error&&<p role="alert">{error}</p>}
 </form>;
}
