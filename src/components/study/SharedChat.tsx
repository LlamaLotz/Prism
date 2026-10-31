import { Plus, MoreHorizontal, ShieldCheck, Info, X, Search, ChevronDown } from 'lucide-react';
import { type OmniRouteConfig } from '../../types';
import { AgentReview } from './AgentReview';
import { useDialog } from '../DialogProvider';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { knowledge, type ChatLibrarySession } from '../../services/knowledge';
import { sharedStudy, study, useSharedStudy, type Collection } from '../../services/study';
import type { ModelPickerOption } from '../ui/ModelPicker';
import { PromptBar } from '../ui/PromptBar';
import { AiStatusLine } from '../ui/AiStatusLine';
import { ResearchPanel } from '../research/ResearchPanel';
import '../research/search-control.css';

/** Shared model-chooser configuration for a prompt bar. */
export interface ChatModelPicker { disabled?:boolean; value: string; options: ModelPickerOption[]; onChange: (value: string) => void | Promise<unknown> }

export function SharedChat({vaultPath,collectionId=null,onOpenSettings,config,modelPicker,onVaultChanged,onSources}: {vaultPath:string;collectionId?:string|null;onOpenSettings?:()=>void;config:OmniRouteConfig;modelPicker?:ChatModelPicker;onVaultChanged?:()=>void;onSources?:()=>void}){
 const dialogs=useDialog();const [draftAgent,setDraftAgent]=useState(true);const sending=useRef(false);const scroll=useRef<HTMLDivElement>(null);const sticky=useRef(true);
 const shared=useSharedStudy(vaultPath);const id=shared.active;const detail=id?shared.details[id]:null;
 const conversation=useRef<string|null>(id);const creating=useRef<Promise<string>|null>(null);
 useEffect(()=>{conversation.current=id;},[id]);
 const draftKey=id??'new';const input=shared.inputs[draftKey]??'';const setInput=(value:string|((previous:string)=>string))=>sharedStudy.setInput(vaultPath,draftKey,typeof value==='function'?value(input):value);const [sessions,setSessions]=useState<ChatLibrarySession[]>([]);const [error,setError]=useState('');const [collections,setCollections]=useState<Collection[]>([]);
 const refresh=()=>knowledge.listChats(null,null,200).then(setSessions).catch(e=>setError(String(e)));
 useEffect(()=>{void refresh();void study.request<Collection[]>(vaultPath,'collections').then(setCollections).catch(()=>{});},[vaultPath,id,detail?.messages.length]);
 useEffect(()=>{if(detail?.managed)return;const pending=detail?.messages.some(m=>m.role==='user')??false;if(!pending||!id)return;let active=true;const entry=sessions.find(row=>row.id===id);if(!entry)return;const timer=window.setTimeout(()=>{void study.adopt(vaultPath,entry).then(()=>study.request<boolean>(vaultPath,'isManaged',{id})).then(managed=>{if(active&&managed)void sharedStudy.open(vaultPath,id);}).catch(e=>setError(String(e)));},0);return()=>{active=false;clearTimeout(timer);};},[vaultPath,id,detail?.managed,detail?.messages.length,sessions]);
 const [draftProvider,setDraftProvider]=useState<string|null>(null);
 const provider=detail?.providerId??draftProvider??modelPicker?.value??'';
 const unavailable=!!modelPicker&&!modelPicker.options.some(option=>option.value===provider);
 // The assistant can only run once a model is actually configured: either a
 // saved provider is picked for this conversation, or the default provider
 // has both an endpoint and a model. Nothing is filled in automatically.
 const configuredDefault=!!(config.baseUrl?.trim()&&config.model?.trim());
 const unconfigured=!provider&&!configuredDefault;
 const autoApprove=!!(id&&shared.autoApprove[id]);
 // Choosing a model persists it for this conversation only: the conversation is
 // materialised on demand (like Approve for me), and a failed save propagates to
 // the picker, which surfaces the error and retains the previous selection.
 const createChat=async(agent=true)=>{const target=await sharedStudy.create(vaultPath,collectionId);sharedStudy.setAgent(vaultPath,target,agent);conversation.current=target;return target;};
 // One creation path for sends, model selection and auto-approval. Without the
 // shared promise/ref, two handlers started before React re-rendered could each
 // create a chat and the auto-approval flag could land on the abandoned one.
 const ensureConversation=async(agent=true)=>{const current=conversation.current??id;if(current)return current;creating.current??=createChat(agent);try{return await creating.current;}finally{creating.current=null;}};
 const conversationModel=modelPicker?{...modelPicker,value:provider,onChange:async(value:string)=>{const target=await ensureConversation();await sharedStudy.setProvider(vaultPath,target,value);}}:undefined;
 const [retryText,setRetryText]=useState('');  const run=async(fn:()=>Promise<unknown>)=>{try{setError('');await fn();await refresh();}catch(e){setError(String(e));}};
 const send=async()=>{if(!input.trim()||sending.current||(id&&shared.running[id]))return;if(discoverMode){const query=input.trim();setInput('');setResearchRun({key:Date.now(),query});return;}sending.current=true;try{const target=await ensureConversation(draftAgent);if(unavailable)throw new Error('Choose an available model before sending.');
 if(unconfigured)throw new Error('Configure an AI provider and model before sending.');if(shared.details[target]?.providerId==null)await sharedStudy.setProvider(vaultPath,target,provider);const text=input;setInput('');setRetryText(text);sticky.current=true;const agentMode=sharedStudyMode(target);const accepted=await (agentMode||webEnabled?sharedStudy.sendAgent(vaultPath,target,text,config,provider,false,{webEnabled,readOnly:!agentMode}):sharedStudy.send(vaultPath,target,text,provider));if(accepted===false)setInput(current=>current||text);}finally{sending.current=false;}};
 const sharedStudyMode=(target:string)=>shared.agentModes[target]??draftAgent;
 const agent=id?!!shared.agentModes[id]:draftAgent;
 const setAgentEnabled=(enabled:boolean)=>{if(id)sharedStudy.setAgent(vaultPath,id,enabled);else setDraftAgent(enabled);};
 const menuRef=useRef<HTMLDetailsElement>(null);
 const closeMenu=()=>{if(menuRef.current)menuRef.current.open=false;};
 const [noticeOpen,setNoticeOpen]=useState(false);const noticeRef=useRef<HTMLDivElement>(null);
 const [webEnabled,setWebEnabled]=useState(false);const [discoverMode,setDiscoverMode]=useState(false);const [searchMenu,setSearchMenu]=useState(false);const [researchRun,setResearchRun]=useState<{key:number;query:string}|null>(null);const searchMenuRoot=useRef<HTMLDivElement>(null);const searchMenuTrigger=useRef<HTMLButtonElement>(null);const searchMenuBody=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(!searchMenu)return;const outside=(event:PointerEvent)=>{if(!searchMenuRoot.current?.contains(event.target as Node))setSearchMenu(false);};const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setSearchMenu(false);searchMenuTrigger.current?.focus();return;}const items=Array.from(searchMenuBody.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]:not(:disabled), [role="menuitem"]:not(:disabled)')??[]);if(!items.length)return;const index=items.indexOf(document.activeElement as HTMLButtonElement);let next:number|undefined;if(event.key==='ArrowDown')next=(index+1)%items.length;if(event.key==='ArrowUp')next=(index-1+items.length)%items.length;if(event.key==='Home')next=0;if(event.key==='End')next=items.length-1;if(next!==undefined){event.preventDefault();items[next]?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',keydown);requestAnimationFrame(()=>searchMenuBody.current?.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.focus());return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keydown);};},[searchMenu]);
 const chooseSearchOption=(apply:()=>void)=>{apply();setSearchMenu(false);requestAnimationFrame(()=>searchMenuTrigger.current?.focus());};
 // Auto-approval is a consent change, so enabling it surfaces the disclaimer
 // in a popover instead of leaving it parked under the composer.
 const toggleAutoApprove=()=>void run(async()=>{const target=await ensureConversation();const enabled=!shared.autoApprove[target];sharedStudy.setAutoApprove(vaultPath,target,enabled);setNoticeOpen(enabled);});
 // The disclaimer only makes sense while auto-approval is on. Switching
 // conversations closes it explicitly (below) rather than by watching the
 // conversation id, which also changes when enabling it creates a draft chat.
 useEffect(()=>{if(!autoApprove)setNoticeOpen(false);},[autoApprove]);
 useEffect(()=>{if(!noticeOpen)return;const onDown=(event:PointerEvent)=>{const target=event.target as Element|null;if(!target)return;if(noticeRef.current?.contains(target)||target.closest?.('[data-approval-control]'))return;setNoticeOpen(false);};const onKey=(event:KeyboardEvent)=>{if(event.key!=='Escape')return;event.stopPropagation();setNoticeOpen(false);};document.addEventListener('pointerdown',onDown,true);document.addEventListener('keydown',onKey,true);return()=>{document.removeEventListener('pointerdown',onDown,true);document.removeEventListener('keydown',onKey,true);};},[noticeOpen]);

 useEffect(()=>{if(sticky.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[detail?.messages.length,id&&shared.drafts[id],id,researchRun]);
 const linked=collections.find(c=>c.id===detail?.collectionId);
 return <section className="study-chat" aria-label="Shared conversation">
  <div className="study-chat-header"><select aria-label="Conversation" value={id??''} onChange={e=>{const row=sessions.find(s=>s.id===e.target.value);if(row){setNoticeOpen(false);void run(async()=>{await study.adopt(vaultPath,row);await sharedStudy.open(vaultPath,row.id);});}}}><option value="">Choose a conversation</option>{sessions.map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select><button aria-label="New chat" title="New chat" onClick={()=>{setNoticeOpen(false);void run(async()=>{setDraftProvider(null);setDraftAgent(true);await createChat();});}}><Plus size={17}/></button><details className="study-menu" ref={menuRef}><summary aria-label="Conversation actions"><MoreHorizontal size={18}/></summary><div className="study-menu-body"><button type="button" aria-pressed={agent} aria-label={`Agent ${agent?'ON':'OFF'}`} title={`Agent ${agent?'ON':'OFF'}`} onClick={()=>{setAgentEnabled(!agent);closeMenu();}}>Agent <span className="study-menu-state" data-on={agent?'':undefined}>{agent?'ON':'OFF'}</span></button><button type="button" disabled={!detail} onClick={()=>{closeMenu();void run(async()=>{const title=await dialogs.prompt('Conversation title',{initialValue:detail?.session.title});if(title?.trim()&&id){await knowledge.renameChat(id,title.trim());await sharedStudy.open(vaultPath,id);}});}}>Rename conversation</button></div></details></div>
  {collectionId&&detail&&detail.collectionId!==collectionId&&<button className="study-scope-note" disabled={shared.running[id!]} onClick={()=>void run(async()=>{await study.request(vaultPath,'adoptChat',{id,collectionId});await sharedStudy.open(vaultPath,id!);})}>Use this collection for future messages</button>}
  {(error||(id&&shared.errors[id]))&&<div role="alert">{error||(id&&shared.errors[id])}<button onClick={onOpenSettings}>AI settings</button></div>}
  <div ref={scroll} className="study-messages" aria-live="polite" onScroll={e=>{const el=e.currentTarget;sticky.current=el.scrollHeight-el.scrollTop-el.clientHeight<70;}}>{!detail?.messages.length&&<div className="study-empty"><ShieldCheck size={30}/><h3>Explore your sources</h3><p>Ask a question, find connections, or turn your notes into something new.</p></div>}{detail?.messages.map(m=><article data-role={m.role} key={m.id}><strong>{m.role==='user'?'You':'Prism'}</strong><ReactMarkdown>{m.content}</ReactMarkdown>{m.metadata&&(()=>{try{const meta=JSON.parse(m.metadata);return meta.excerpts?<small>Uses selected excerpts rather than complete source coverage.</small>:null;}catch{return null;}})()}</article>)}{id&&shared.running[id]&&<article data-role="assistant"><strong>Prism</strong>{shared.drafts[id]?<ReactMarkdown>{shared.drafts[id]}</ReactMarkdown>:null}</article>}{researchRun&&<ResearchPanel key={researchRun.key} vaultPath={vaultPath} collections={collections} collectionId={collectionId??undefined} initialQuery={researchRun.query} includeWebDefault useSourcesDefault={!!collectionId} autoStart onClose={()=>setResearchRun(null)} />}</div>
  {id&&shared.activity[id]&&<AiStatusLine activity={shared.activity[id]} phase={shared.phases[id]||''}/>}
  {agent&&id&&<AgentReview key={vaultPath} onVaultChanged={onVaultChanged} onMessage={async text=>{const row=await knowledge.appendChat(id,'assistant',text,JSON.stringify({agent:true}));await sharedStudy.refreshMessage(vaultPath,id,row);}}/>}
  <PromptBar value={input} onChange={setInput} onSend={send} running={!!(id&&shared.running[id])} onStop={()=>id?sharedStudy.cancel(vaultPath,id):Promise.resolve()} model={conversationModel} disabled={unavailable||unconfigured} placeholder={discoverMode?'Research a topic…':undefined} extra={<>
   {agent&&<>
   <button type="button" data-approval-control aria-pressed={autoApprove} aria-label={`Approve for me ${autoApprove?'ON':'OFF'}`} title={`Approve for me ${autoApprove?'ON':'OFF'}`} onClick={toggleAutoApprove}><ShieldCheck size={14} aria-hidden="true"/></button>
   {autoApprove&&<button type="button" data-approval-control className="prompt-bar__info" aria-label="Approval details" title="Approval details" aria-expanded={noticeOpen} onClick={()=>setNoticeOpen(open=>!open)}><Info size={14} aria-hidden="true"/></button>}
   {autoApprove&&noticeOpen&&<div ref={noticeRef} className="prompt-bar__notice" role="dialog" aria-label="Approval details">
    <div className="prompt-bar__notice-head"><strong>Approve for me</strong><button type="button" aria-label="Close approval details" title="Close" onClick={()=>setNoticeOpen(false)}><X size={14} aria-hidden="true"/></button></div>
    <p>Vault changes are approved automatically in this conversation. Undo is available in history. External processing still needs its own consent.</p>
   </div>}
   </>}
   <div className="ai-search-control" ref={searchMenuRoot}><button type="button" title="Let the AI search the web" aria-pressed={webEnabled} onClick={()=>setWebEnabled(value=>!value)}><Search size={14}/> Web</button><button ref={searchMenuTrigger} type="button" className="ai-search-caret" aria-label="Search options" aria-haspopup="menu" aria-expanded={searchMenu} aria-controls={searchMenu?'ai-search-menu':undefined} onClick={()=>setSearchMenu(value=>!value)}><ChevronDown size={13} aria-hidden="true"/></button>{searchMenu&&<div id="ai-search-menu" ref={searchMenuBody} className="ai-search-menu" role="menu" aria-label="Search options"><button type="button" role="menuitemcheckbox" aria-checked={webEnabled} tabIndex={-1} onClick={()=>chooseSearchOption(()=>setWebEnabled(value=>!value))}>Web search<span className="ai-search-menu__state">{webEnabled?'On':'Off'}</span></button><button type="button" role="menuitemcheckbox" aria-checked={discoverMode} tabIndex={-1} onClick={()=>chooseSearchOption(()=>setDiscoverMode(value=>!value))}>Discover sources<span className="ai-search-menu__state">{discoverMode?'On':'Off'}</span></button><button type="button" role="menuitem" tabIndex={-1} disabled>Deep research (soon)</button></div>}</div>
  </>} onContext={onSources} context={linked?`${linked.sourceIds.length} sources`:collectionId&&!detail?`${collections.find(c=>c.id===collectionId)?.sourceIds.length??0} sources`:undefined}/>

  {unavailable&&<p role="alert">This model profile was removed. Choose an available model to continue.</p>}
  {unconfigured&&<div role="alert">No AI model is configured yet. Choose a provider and model to start chatting.{onOpenSettings&&<button type="button" onClick={onOpenSettings}>AI settings</button>}</div>}
  {agent&&!autoApprove&&<p className="study-scope-note">Vault changes wait for your approval.</p>}
  {id&&shared.paused[id]&&<button disabled={shared.running[id]} onClick={()=>void sharedStudy.sendAgent(vaultPath,id,'Continue the paused task',config,provider,true,{webEnabled,readOnly:!agent})}>Continue agent</button>}
  {id&&shared.errors[id]&&<button onClick={()=>{const last=retryText||detail?.messages.filter(m=>m.role==='user').at(-1)?.content;if(last)void ((agent||webEnabled)?sharedStudy.sendAgent(vaultPath,id,last,config,provider,false,{webEnabled,readOnly:!agent}):sharedStudy.send(vaultPath,id,last,provider));}}>Retry response</button>}
 </section>;
}
