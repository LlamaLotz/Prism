import { Plus, MoreHorizontal, ShieldCheck } from 'lucide-react';
import type { OmniRouteConfig } from '../../types';
import { AgentReview } from './AgentReview';
import { useDialog } from '../DialogProvider';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { knowledge, type ChatLibrarySession } from '../../services/knowledge';
import { sharedStudy, study, useSharedStudy, type Collection } from '../../services/study';
import type { ModelPickerOption } from '../ui/ModelPicker';
import { PromptBar } from '../ui/PromptBar';
import { AiStatusLine } from '../ui/AiStatusLine';

/** Shared model-chooser configuration for a prompt bar. */
export interface ChatModelPicker { value: string; options: ModelPickerOption[]; onChange: (value: string) => void | Promise<unknown> }

export function SharedChat({vaultPath,collectionId=null,onOtherView,onOpenSettings,config,modelPicker,onVaultChanged,onSources}: {vaultPath:string;collectionId?:string|null;onOtherView?:()=>void;onOpenSettings?:()=>void;config:OmniRouteConfig;modelPicker?:ChatModelPicker;onVaultChanged?:()=>void;onSources?:()=>void}){
 const dialogs=useDialog();const [draftAgent,setDraftAgent]=useState(false);const sending=useRef(false);const scroll=useRef<HTMLDivElement>(null);const sticky=useRef(true);
 const shared=useSharedStudy(vaultPath);const id=shared.active;const detail=id?shared.details[id]:null;
 const [input,setInput]=useState('');const [sessions,setSessions]=useState<ChatLibrarySession[]>([]);const [error,setError]=useState('');const [collections,setCollections]=useState<Collection[]>([]);
 const refresh=()=>knowledge.listChats(null,null,200).then(setSessions).catch(e=>setError(String(e)));
 useEffect(()=>{void refresh();void study.request<Collection[]>(vaultPath,'collections').then(setCollections).catch(()=>{});},[vaultPath,id,detail?.messages.length]);
 useEffect(()=>{if(detail?.managed)return;const pending=detail?.messages.some(m=>m.role==='user')??false;if(!pending||!id)return;let active=true;const entry=sessions.find(row=>row.id===id);if(!entry)return;const timer=window.setTimeout(()=>{void study.legacy(vaultPath,entry).then(()=>study.request<boolean>(vaultPath,'isManaged',{id})).then(managed=>{if(active&&managed)void sharedStudy.open(vaultPath,id);}).catch(e=>setError(String(e)));},0);return()=>{active=false;clearTimeout(timer);};},[vaultPath,id,detail?.managed,detail?.messages.length,sessions]);
 const [retryText,setRetryText]=useState('');  const run=async(fn:()=>Promise<unknown>)=>{try{setError('');await fn();await refresh();}catch(e){setError(String(e));}};
 const send=async()=>{if(!input.trim()||sending.current||(id&&shared.running[id]))return;sending.current=true;try{let target=id;if(!target){target=await sharedStudy.create(vaultPath,collectionId);sharedStudy.setAgent(vaultPath,target,draftAgent);}const text=input;setInput('');setRetryText(text);sticky.current=true;const accepted=await (sharedStudyMode(target)?sharedStudy.sendAgent(vaultPath,target,text,config,modelPicker?.value):sharedStudy.send(vaultPath,target,text,modelPicker?.value));if(accepted===false)setInput(current=>current||text);}finally{sending.current=false;}};
 const sharedStudyMode=(target:string)=>shared.agentModes[target]??draftAgent;
 const agent=id?!!shared.agentModes[id]:draftAgent;

 useEffect(()=>{if(sticky.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[detail?.messages.length,id&&shared.drafts[id],id]);
 const linked=collections.find(c=>c.id===detail?.collectionId);
 return <section className="study-chat" aria-label="Shared conversation">
  <div className="study-chat-header"><select aria-label="Conversation" value={id??''} onChange={e=>{const row=sessions.find(s=>s.id===e.target.value);if(row)void run(async()=>{await study.legacy(vaultPath,row);await sharedStudy.open(vaultPath,row.id);});}}><option value="">Choose a conversation</option>{sessions.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select><button aria-label="New chat" title="New chat" onClick={()=>void run(()=>sharedStudy.create(vaultPath,collectionId))}><Plus size={17}/></button><details className="study-menu"><summary aria-label="Conversation actions"><MoreHorizontal size={18}/></summary><div className="study-menu-body"><button disabled={!detail} onClick={()=>void run(async()=>{const title=await dialogs.prompt('Conversation title',{initialValue:detail?.session.title});if(title?.trim()&&id){await knowledge.renameChat(id,title.trim());await sharedStudy.open(vaultPath,id);}})}>Rename conversation</button>{onOtherView&&<button onClick={onOtherView}>Open in other view</button>}</div></details></div>
  {collectionId&&detail&&detail.collectionId!==collectionId&&<button className="study-scope-note" disabled={shared.running[id!]} onClick={()=>void run(async()=>{await study.request(vaultPath,'adoptChat',{id,collectionId});await sharedStudy.open(vaultPath,id!);})}>Use this collection for future messages</button>}
  {(error||(id&&shared.errors[id]))&&<div role="alert">{error||(id&&shared.errors[id])}<button onClick={onOpenSettings}>AI settings</button></div>}
  <div ref={scroll} className="study-messages" aria-live="polite" onScroll={e=>{const el=e.currentTarget;sticky.current=el.scrollHeight-el.scrollTop-el.clientHeight<70;}}>{!detail?.messages.length&&<div className="study-empty"><ShieldCheck size={30}/><h3>Explore your sources</h3><p>Ask a question, find connections, or turn your notes into something new.</p></div>}{detail?.messages.map(m=><article data-role={m.role} key={m.id}><strong>{m.role==='user'?'You':'Prism'}</strong><ReactMarkdown>{m.content}</ReactMarkdown>{m.metadata&&(()=>{try{const meta=JSON.parse(m.metadata);return meta.excerpts?<small>Uses selected excerpts rather than complete source coverage.</small>:null;}catch{return null;}})()}</article>)}{id&&shared.running[id]&&<article data-role="assistant"><strong>Prism</strong>{shared.drafts[id]?<ReactMarkdown>{shared.drafts[id]}</ReactMarkdown>:null}</article>}</div>
  {id&&shared.activity[id]&&<AiStatusLine activity={shared.activity[id]} phase={shared.phases[id]||''}/>}
  {agent&&id&&<AgentReview key={vaultPath} onVaultChanged={onVaultChanged} onMessage={async text=>{const row=await knowledge.appendChat(id,'assistant',text,JSON.stringify({agent:true}));await sharedStudy.refreshMessage(vaultPath,id,row);}}/>}
  <PromptBar value={input} onChange={setInput} onSend={send} running={!!(id&&shared.running[id])} onStop={()=>id?sharedStudy.cancel(vaultPath,id):Promise.resolve()} model={modelPicker} agent={agent} onAgent={enabled=>{if(id)sharedStudy.setAgent(vaultPath,id,enabled);else setDraftAgent(enabled);}} onContext={onSources} context={linked?`${linked.sourceIds.length} sources`:collectionId&&!detail?`${collections.find(c=>c.id===collectionId)?.sourceIds.length??0} sources`:'Vault context'}/>

  {agent&&<p className="study-scope-note">Agent can use vault-wide tools. Changes require your approval.</p>}
  {id&&shared.errors[id]&&<button onClick={()=>{const last=retryText||detail?.messages.filter(m=>m.role==='user').at(-1)?.content;if(last)void (agent?sharedStudy.sendAgent(vaultPath,id,last,config):sharedStudy.send(vaultPath,id,last));}}>Retry response</button>}
 </section>;
}
