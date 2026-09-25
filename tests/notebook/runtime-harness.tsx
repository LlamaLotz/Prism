import React, {useState} from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeActivity, JobsButton } from '../../src/components/RuntimeActivity';
import '../../src/index.css';
import {AISidebar} from '../../src/components/AISidebar';
import {AIRoutingSettings} from '../../src/components/AIRoutingSettings';
import {DialogProvider} from '../../src/components/DialogProvider';
import {ChatLibraryProvider} from '../../src/services/chatLibrary';
import type {AppSettings} from '../../src/types';
const query=new URLSearchParams(location.search);
document.documentElement.className=`theme-${query.get('theme') || 'industrial'} mode-${query.get('mode') || 'dark'}`;
const calls: unknown[] = [];
let approvals = [{id:'approval-1', destination:'https://fixture.example',task:'NOTEBOOK',scope:'2 messages, 120 bytes',payloadHash:'fixture',vaultId:'vault-1'}];
let jobs = [{id:'job-1',kind:'EMBED',state:'running',priority:10,progress:0.25,error:null}];
if(query.has('empty')) jobs=[];
if(query.has('noapproval')) approvals=[];
if(query.has('multiple')) approvals.push({...approvals[0],id:'approval-2'});
if(query.has('states')) jobs.push(...['queued','waiting_for_approval','failed','cancelled'].map((state,i)=>({id:`job-${i+2}`,kind:'INDEX',state,priority:10,progress:0,error:state==='failed'?'Unable to process '+ 'long-path/'.repeat(35):null})));
Object.assign(window,{fixtureCalls:calls});
Object.defineProperty(window,'__TAURI_EVENT_PLUGIN_INTERNALS__',{value:{unregisterListener:()=>{}}});
Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:Record<string,unknown>={})=>{
 calls.push({command,args});
 if(command==='list_chat_sessions')return [];
 if(command==='agent_list_pending')return [{id:'edit-1',tool:'edit_note',vaultId:'vault-1',notePath:'/vault/'+ 'long-folder/'.repeat(12)+'note.md',preview:'- Original paragraph\n+ Revised paragraph with source citation',createdAt:0,input:{}}];
 if(command==='list_approvals')return structuredClone(approvals);
 if(command==='list_knowledge_jobs')return structuredClone(jobs);
 if(command==='resolve_approval'){approvals=approvals.filter(a=>a.id!==args.id);return;}
 if(command==='cancel_knowledge_job'){if(query.has('cancelerror')) throw new Error('Cancellation failed; please retry.');jobs[0].state='cancelled';return;}
 if(command.startsWith('plugin:'))return 1;
 throw new Error(command);
}}});
const defaults={omniRoute:{provider:'fixture',baseUrl:'https://fixture.example',model:'default-model'},models:{privacy:'ask_before_cloud',idleSeconds:300,routes:{},providers:[{id:'saved',name:'Saved provider',config:{model:'feature-model',credentialRef:'keychain-fixture'},capabilities:['generation']}]}} as unknown as AppSettings;
function Fixture(){
 const [draft,setDraft]=useState<AppSettings>(()=>JSON.parse(localStorage.getItem('runtime-settings') || 'null') || defaults);
 const [collapsed,setCollapsed]=useState(query.has('collapsed'));
 return <RuntimeActivity><div style={{display:'flex',minHeight:'100vh',background:'var(--color-base)',color:'var(--color-text-hi)'}}>
 <nav aria-label="Navigation" style={{width:collapsed?44:240,flexShrink:0,padding:8,display:'flex',alignItems:'start',alignContent:'flex-start',flexDirection:collapsed?'column':'row',gap:8,flexWrap:'wrap',background:'var(--color-panel)'}}><button className="runtime-button" onClick={()=>setCollapsed(!collapsed)} aria-label="Toggle navigation">☰</button><JobsButton/></nav>
 <main style={{padding:16,minWidth:0,flex:1}}>{query.has('agent')?<div style={{width:'100%',maxWidth:360,height:700}}><AISidebar note={null} allNotes={[]} config={draft.omniRoute} onOpenSettings={()=>{}} onInsertText={()=>{}}/></div>:query.has('settings')?<><AIRoutingSettings draft={draft} setDraft={setDraft}/><button className="runtime-button" onClick={()=>localStorage.setItem('runtime-settings',JSON.stringify(draft))}>Save settings</button></>:<h1>Workspace</h1>}</main>
 </div></RuntimeActivity>;
}
createRoot(document.getElementById('root')!).render(<ChatLibraryProvider><DialogProvider><Fixture/></DialogProvider></ChatLibraryProvider>);
