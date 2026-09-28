import { ModelServiceRecovery } from '../../src/components/ModelServiceRecovery';
import { AIEnhancements } from '../../src/components/AIEnhancements';
import React, {useState} from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentImports, DocumentSourcesButton } from '../../src/components/DocumentImports';
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
let pending=[{id:'edit-1',tool:'edit_note',vaultId:'vault-1',notePath:'/vault/'+ 'long-folder/'.repeat(12)+'note.md',preview:'- Original paragraph\n+ Revised paragraph with source citation',createdAt:0,input:{noteId:'note-1',operations:[{op:'append',text:'Revised'}]}}];
if(query.has('rounds')) pending=[];
let operations=JSON.parse(localStorage.getItem('fixture-operations') || '[]');
if(query.has('manyoperations')) operations=Array.from({length:10},(_,i)=>({id:`op-${i}`,tool:'edit_note',notePath:'/vault/'+ 'long-folder/'.repeat(12)+'note.md',state:i===0?'recovery_required':'applied',undoAvailable:i!==0,error:i===0?'Index failed; recovery data retained':null}));
let chats=JSON.parse(localStorage.getItem('fixture-chats') || '[]');
let transcript=JSON.parse(localStorage.getItem('fixture-transcript') || '[]');
let modelRound=0;
let checks=0;
const source=(id:string)=>({noteId:`note-${id}`,blockId:`block-${id}`,path:`/vault/${id}.md`,title:`Source ${id}`,anchor:null,headingPath:[]});
let importOptions=JSON.parse(localStorage.getItem('document-options')||'null')||{name:'Research 日本',folder:'Research',splitLevel:null,keepSource:false,separateCopy:false,excludedOutputs:[]};
let importState=localStorage.getItem('document-state')||'review';
let previewToken='token-1',refreshed=false;
const documentOutputs=()=>Array.from({length:query.has('paged')?101:importOptions.splitLevel?3:1},(_,i)=>({key:i===0?'root':`section-${i}`,name:`${importOptions.name}${i?` - Section ${i}`:''}.md`,path:`/vault/${importOptions.folder}/${importOptions.name}${i?` - Section ${i}`:''}.md`,markdown:i===0?'# Research 日本\n\nOriginal excerpt 🦀\n\n| Source | Evidence |\n| --- | --- |\n| A | Preserved |':'## Section '+i+'\n\nSection body.',totalChars:query.has('longpreview')?9000:110,conflict:query.has('importconflict')&&!importOptions.separateCopy?'CONFLICT: Generated note was edited. '+ 'long-path/'.repeat(25):null})).filter(o=>!importOptions.excludedOutputs.includes(o.key));
Object.assign(window,{fixtureCalls:calls});
Object.defineProperty(window,'__TAURI_EVENT_PLUGIN_INTERNALS__',{value:{unregisterListener:()=>{}}});
Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:Record<string,unknown>={})=>{
 calls.push({command,args});
 if(command==='list_document_imports')return query.has('documents')&&!['imported','cancelled','undone'].includes(importState)?[{id:'import-1',title:importOptions.name,state:query.has('recovery')?'recovery_required':importState,revision:'revision-1',outputs:documentOutputs().length,needsRefresh:query.has('restart')&&!refreshed}]:[];
 if(command==='get_document_preview'){const offset=Number(args.offset||0);const all=documentOutputs();return {id:'import-1',token:previewToken,options:structuredClone(importOptions),outputs:all.slice(offset,offset+Number(args.limit||100)).map(o=>({...o,markdown:args.contentOffset?'Remaining source text':o.markdown})),offset,total:all.length,warnings:['Some original source locations are unavailable.'],retained:query.has('retained')?['/vault/Previous section.md']:[],skipped:importOptions.excludedOutputs.map((key:string)=>[key,`Excluded ${key}.md`]),needsRefresh:query.has('restart')&&!refreshed};}
 if(command==='update_document_import'){importOptions=structuredClone(args.options);localStorage.setItem('document-options',JSON.stringify(importOptions));previewToken='token-2';refreshed=true;return;}
 if(command==='commit_document_import'){if(query.has('staleimport'))throw new Error('CONFLICT: Source changed since review. Refresh the import preview.');if(args.token!==previewToken)throw new Error('Stale approval');importState='imported';localStorage.setItem('document-state',importState);return {operationId:'document:1',undoAvailable:true,paths:documentOutputs().map(o=>o.path)};}
 if(command==='recover_document_import'){if(query.has('recoveryconflict'))throw new Error('RECOVERY_REQUIRED: Files changed; recovery data retained.');importState='undone';return;}
 if(command==='list_note_document_sources')return {entries:[{blockId:'source-block',excerpt:'Original source excerpt',line:3}],offset:0,total:1};
 if(command==='get_document_source')return {blockId:args.blockId,title:'Source document',revision:'revision-1',extractor:'Native PDF',extractorVersion:'fixture',excerpt:'Stored excerpt 日本 🦀',modified:true,source:'/original/source.pdf',sourceStatus:query.has('missingsource')?'missing':'available',retained:false,location:{page:2,bbox:[0,0,100,100]}};
 if(command==='open_document_source')return;
 if(command==='list_chat_sessions')return chats;
 if(command==='create_chat_session'){const row={id:'chat-1',title:args.title,origin:'copilot',messageCount:0,createdAt:1,updatedAt:1};chats=[row];localStorage.setItem('fixture-chats',JSON.stringify(chats));return row;}
 if(command==='append_chat_message'){const row={...args,id:`message-${transcript.length}`,createdAt:1};transcript.push(row);localStorage.setItem('fixture-transcript',JSON.stringify(transcript));return row;}
 if(command==='get_chat_messages')return transcript;
 if(command==='agent_list_tools')return [{name:'read_note',description:'Read a note',requiresApproval:false,category:'read'}];
 if(command==='plan_retrieval')return {query:'fixture',blocks:[],contextText:'Source material',citations:[source('paged-out')],contextCitations:modelRound===0?[source('A')]:[source('A'),source('B')],degraded:modelRound===0?'Embeddings unavailable; lexical results used':null};
 if(command==='model_service_status'){checks++;return {state:checks>1?'ready':'unavailable',command:'ollama serve',message:checks>1?'Ready':'Start your installed service.'};}
 if(command==='prepare_ai_enhancement')return {tool:'edit_note',requiresApproval:true,approvalId:'edit-1',preview:'- Original\n+ Formatted',result:null,error:null};
 if(command==='execute_model'){if(query.has('service') && checks<2)throw new Error('SERVICE_UNAVAILABLE: Provider connection failed');modelRound++;return modelRound===1?'```json\n{"tool":"read_note","input":{"noteId":"note-A"}}\n```':'Final answer from both rounds.';}
 if(command==='agent_call_tool'){
  const request=args.request as {tool:string;input:unknown};
  if(request.tool==='read_note')return {tool:'read_note',result:{content:'Source A'},requiresApproval:false};
  pending=[{...pending[0],id:'edit-2',tool:'edit_note',notePath:'/vault/note.md',preview:'- Current source\n+ Fresh revision',vaultId:'vault-1',input:request.input as any,createdAt:1}];
  return {tool:'edit_note',requiresApproval:true,approvalId:'edit-2',preview:pending[0].preview};
 }
 if(command==='agent_resolve_pending'){
  if(query.has('conflict')&&args.id==='edit-1'){pending=[];throw new Error('CONFLICT: Source changed since review. Generate a fresh preview.');}
  pending=[];if(!args.approved)return {approved:false,id:args.id};
  operations=[{id:'op-1',tool:'edit_note',notePath:'/vault/note.md',state:'applied',undoAvailable:true,error:null}];localStorage.setItem('fixture-operations',JSON.stringify(operations));
  return {approved:true,id:args.id,result:{operationId:'op-1',undoAvailable:true,notePath:'/vault/note.md',relativePath:'note.md',preview:'Fresh revision'}};
 }
 if(command==='agent_recheck_operation'){operations=operations.map((o:any)=>o.id===args.operationId?{...o,state:'applied',undoAvailable:true,error:null}:o);return;}
 if(command==='agent_undo_operation'){
  if(query.has('undoconflict'))throw new Error('CONFLICT: Source changed after the operation.');
  operations=[];localStorage.setItem('fixture-operations','[]');return {operationId:args.operationId,notePath:'/vault/note.md',relativePath:'note.md',preview:'Original restored'};
 }
 if(command==='agent_list_operations')return structuredClone(operations);
 if(command==='agent_list_pending')return structuredClone(pending);
 if(command==='list_approvals')return structuredClone(approvals);
 if(command==='list_knowledge_jobs')return structuredClone(jobs);
 if(command==='resolve_approval'){approvals=approvals.filter(a=>a.id!==args.id);return;}
 if(command==='cancel_knowledge_job'){if(args.id==='import-1'){importState='cancelled';return;}if(query.has('cancelerror')) throw new Error('Cancellation failed; please retry.');jobs[0].state='cancelled';return;}
 if(command.startsWith('plugin:'))return 1;
 throw new Error(command);
}}});
const defaults={omniRoute:{provider:'fixture',baseUrl:'https://fixture.example',model:'default-model'},models:{privacy:'ask_before_cloud',idleSeconds:300,routes:{},providers:[{id:'saved',name:'Saved provider',config:{model:'feature-model',credentialRef:'keychain-fixture'},capabilities:['generation']}]}} as unknown as AppSettings;
function Fixture(){
 const [draft,setDraft]=useState<AppSettings>(()=>JSON.parse(localStorage.getItem('runtime-settings') || 'null') || defaults);
 const [collapsed,setCollapsed]=useState(query.has('collapsed'));
 return <DocumentImports onPublished={()=>calls.push({command:"refresh_vault"})}><RuntimeActivity><ModelServiceRecovery/><div style={{display:'flex',minHeight:'100vh',background:'var(--color-base)',color:'var(--color-text-hi)'}}>
 <nav aria-label="Navigation" style={{width:collapsed?44:240,flexShrink:0,padding:8,display:'flex',alignItems:'start',alignContent:'flex-start',flexDirection:collapsed?'column':'row',gap:8,flexWrap:'wrap',background:'var(--color-panel)'}}><button className="runtime-button" onClick={()=>setCollapsed(!collapsed)} aria-label="Toggle navigation">☰</button><JobsButton/></nav>
 <main style={{padding:16,minWidth:0,flex:1}}>{query.has('agent')?<div style={{width:'100%',maxWidth:360,height:700}}><AISidebar note={null} allNotes={[]} config={draft.omniRoute} onOpenSettings={()=>{}} onInsertText={()=>{}} onOpenSource={async source=>{calls.push({command:'navigate_source',source});}}/></div>:query.has('settings')?<><AIRoutingSettings draft={draft} setDraft={setDraft}/><button className="runtime-button" onClick={()=>localStorage.setItem('runtime-settings',JSON.stringify(draft))}>Save settings</button></>:<><h1>Workspace</h1>{query.has("enhancements")&&<AIEnhancements path="/vault/note.md" content="Original" onChanged={async()=>{}}/>}{query.has("documents")&&<DocumentSourcesButton path="/vault/Imported.md"/>}</>}</main>
 </div></RuntimeActivity></DocumentImports>;
}
createRoot(document.getElementById('root')!).render(<ChatLibraryProvider><DialogProvider><Fixture/></DialogProvider></ChatLibraryProvider>);
