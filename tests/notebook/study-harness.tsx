import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {StudyWorkspace} from '../../src/components/study/StudyWorkspace';
import {AssistantWorkspace} from '../../src/components/study/AssistantWorkspace';
import {NavigationMenu} from '../../src/components/NavigationMenu';
import {DialogProvider} from '../../src/components/DialogProvider';
import {sharedStudy} from '../../src/services/study';
import '../../src/index.css';
const query=new URLSearchParams(location.search);
document.documentElement.className=`theme-${query.get('theme')||'industrial'} mode-${query.get('mode')||'dark'}`;
const calls:any[]=[],chats:any[]=[],messages:Record<string,any[]>={};let pending:any[]=[],operations:any[]=[];
if(query.has('history'))operations=Array.from({length:12},(_,i)=>({id:`op${i}`,tool:'edit_note',notePath:`/vault/Note ${i}.md`,state:'applied',undoAvailable:true}));
const sources=[{id:'s1',title:'திருக்குறள் · Virtue and learning',path:'Literature/திருக்குறள்.md',text:'Selected Tamil source. Learning is a lifelong practice.',hash:'h1',missing:false},{id:'s2',title:'Testing fundamentals and a deliberately long source title',path:'Computer Science/Testing.md',text:'Tests verify behavior.',hash:'h2',missing:false}];
let collections:any[]=query.has('empty')?[]:[{id:'c1',title:'Learning across disciplines',sourceIds:['s1','s2'],revision:1}];
if(query.has('library'))collections.push(...Array.from({length:5},(_,i)=>({id:`book${i}`,title:i===2?'அறத்துப்பால் · A deliberately long notebook title for studying multilingual content':`Research notebook ${i+1}`,sourceIds:['s1'],revision:1})));
const bodies:any={flashcards:{cards:[{id:'f1',front:'What are the three main sections of the Thirukkural?',back:'Virtue, wealth, and love.',sourceIds:['s1']},{id:'f2',front:'அறத்துப்பால் (Virtue): What is the value of learning?',back:'Learning supports wisdom.',sourceIds:['s1']}]},quiz:{questions:[{id:'q1',question:'What does a good test verify?',options:['Behavior','Formatting alone','Nothing'],answer:0,explanation:'Behavior matters.',sourceIds:['s2']},{id:'q2',question:'Which section concerns virtue?',options:['அறத்துப்பால்','Other'],answer:0,explanation:'அறத்துப்பால் concerns virtue.',sourceIds:['s1']}]},slides:{slides:[{id:'sl1',title:'அறத்துப்பால் (Virtue): Introduction',bullets:['Section: பாயிரவியல் (Introduction)','Chapter 1: The Praise of God','Chapter 2: The Excellence of Rain'],notes:'Introduce the main themes.',sourceIds:['s1']},{id:'sl2',title:'Testing fundamentals',bullets:['Verify observable behavior','Keep tests understandable'],notes:'Connect with the source.',sourceIds:['s2']}]},table:{columns:['Topic','Description'],rows:[{cells:['Virtue','அறத்துப்பால்'],sourceIds:['s1']},{cells:['Testing','Behavior'],sourceIds:['s2']}]},mindmap:{nodes:[{id:'n1',parentId:null,label:'Learning',sourceIds:['s1']},{id:'n2',parentId:'n1',label:'Testing',sourceIds:['s2']}]},podcast:{transcript:'A source-grounded conversation about learning.'}};
let artifacts=query.has('empty')?[]:Object.keys(bodies).map((kind,i)=>({id:kind,collectionId:'c1',kind,title:{flashcards:'Thirukkural Structure and Testing Fundamentals',quiz:'Learning check',slides:'Introduction to the Thirukkural',table:'Learning comparison',mindmap:'Connected ideas',podcast:'A conversation about learning'}[kind],version:1,parentId:null,snapshotId:'snap',body:bodies[kind],created:1700000000+i}));
const reviews:any[]=[],attempts:any[]=[];
const snapshot={id:'snap',sources,context:sources.map(s=>s.text).join('\n'),excerpts:true,created:1};
let modelRound=0;
const bigPreview=Array.from({length:30},(_,i)=>`- line ${i} removed from the note\n+ line ${i} added with new evidence`).join('\n');
Object.assign(window,{fixtureCalls:calls,fixtureMessages:messages});
Object.defineProperty(window,'__TAURI_EVENT_PLUGIN_INTERNALS__',{value:{unregisterListener:()=>{}}});
Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:any={})=>{
 calls.push({command,args});
 if(command.startsWith('plugin:'))return 1;
 if(command==='list_chat_sessions')return chats;
 if(command==='append_chat_message'){const row={id:`m${messages[args.sessionId].length}`,role:args.role,content:args.content,metadata:args.metadata};messages[args.sessionId].push(row);return row;}
 if(command==='rename_chat_session'){const c=chats.find(c=>c.id===args.id);c.title=args.title;return c;}
 if(command==='study_request'){
  const p=args.payload;
  switch(args.action){
   case 'collections':return structuredClone(collections);
   case 'notes':return {items:sources,nextOffset:null};
   case 'sources':return sources.filter(s=>collections.find(c=>c.id===p.collectionId)?.sourceIds.includes(s.id));
   case 'saveCollection':{if(collections.some(c=>c.id!==p.id&&c.title.trim().toLowerCase()===p.title.trim().toLowerCase()))throw new Error('A notebook with this name already exists');const c={...p,id:p.id||crypto.randomUUID(),revision:(p.revision??0)+1};collections=collections.filter(row=>row.id!==c.id).concat(c);return c;}
   case 'setCollectionCover':{const c=collections.find(c=>c.id===p.id);Object.assign(c,{cover:p.cover,revision:c.revision+1});return structuredClone(c);}
   case 'deleteCollection':{collections=collections.filter(c=>c.id!==p.id);artifacts=artifacts.filter(a=>a.collectionId!==p.id);for(const c of chats)if(c.collectionId===p.id)c.collectionId=null;return true;}
   case 'artifacts':return structuredClone(artifacts.filter(a=>!p.collectionId||a.collectionId===p.collectionId));
   case 'artifact':return structuredClone({artifact:artifacts.find(a=>a.id===p.id),snapshot,reviews,attempts,sourcesChanged:false});
   case 'previewSource':return sources.find(s=>s.id===p.id);
   case 'snapshot':return snapshot;
   case 'saveArtifact':{const a=artifacts.find(a=>a.id===p.id)!;Object.assign(a,{title:p.title,body:p.body,version:a.version+1});return a;}
   case 'review':reviews.push({cardId:p.cardId,due:Date.now()/1000+86400,intervalDays:1});return true;
   case 'quizAttempt':attempts.push({score:p.answers.filter((v:number)=>v===0).length,total:2,created:1});return true;
   case 'newChat':{const c={id:`chat${chats.length}`,title:'Study conversation',origin:'copilot',collectionId:p.collectionId,messageCount:0};chats.push(c);messages[c.id]=[];return c;}
   case 'setChatProvider':{if(query.has('modelError'))throw new Error('Unable to save model');chats.find(c=>c.id===p.id).providerId=p.providerId;return true;}
   case 'chat':{const c=chats.find(c=>c.id===p.id);return {session:c,collectionId:c.collectionId,managed:true,providerId:c.providerId,messages:structuredClone(messages[p.id])};}
   case 'isManaged':return true;
   case 'adoptChat':chats.find(c=>c.id===p.id).collectionId=p.collectionId;return true;
   case 'audio':throw new Error('No audio saved');
   case 'cancelChat':return true;
  }
 }
 if(command==='study_chat'){messages[args.sessionId].push({id:'user'+Date.now(),role:'user',content:args.message},{id:'reply'+Date.now(),role:'assistant',content:'A grounded answer from your selected sources.'});return true;}
 if(command==='study_generate'){await new Promise(r=>setTimeout(r,query.has('slowTools')?2500:350));if(query.has('failure'))throw new Error('Generation failed. Please retry.');const a={...artifacts.find(a=>a.kind===args.kind)!,id:crypto.randomUUID(),collectionId:args.collectionId,title:'New learning material'};artifacts.push(a);return a;}
 if(command==='study_export')return true;
 if(command==='agent_list_tools')return [{name:'read_note',description:'Read a note',requiresApproval:false},{name:'edit_note',description:'Prepare an edit',requiresApproval:true}];
 if(command==='agent_list_pending')return structuredClone(pending);
 if(command==='agent_list_operations')return structuredClone(operations);
 if(command==='agent_call_tool'){const {tool,input}=args.request;if(tool==='read_note')return {tool,result:{text:'Retrieved source'},requiresApproval:false};pending=[{id:'p1',tool,input,preview:bigPreview,notePath:'/vault/Test.md'}];return {tool,approvalId:'p1',requiresApproval:true,preview:pending[0].preview};}
 if(command==='agent_resolve_pending'){pending=[];if(args.approved)operations=[{id:'op1',tool:'edit_note',notePath:'/vault/Test.md',state:'applied',undoAvailable:true}];return {approved:args.approved};}
 if(command==='agent_undo_operation'){operations=[];return {relativePath:'Test.md'};}
 if(command==='execute_model'){modelRound++;if(query.has('slow'))await new Promise(r=>setTimeout(r,800));return modelRound===1?'```json\n{"tool":"read_note","input":{"noteId":"s1"}}\n```':'Agent answer using selected sources.';}
 throw new Error(`Unhandled fixture ${command}: ${args.action}`);
}}});
function Fixture(){const [view,setView]=useState('notebook');const [vault,setVault]=useState('/vault');const [chatModel,setChatModel]=useState('m1');const config={baseUrl:'fixture',model:'fixture'} as any;const modelPicker={value:chatModel,options:[{value:'m1',label:'Fixture model',description:'fixture · fast'},{value:'m2',label:'Other model',description:'fixture · precise',tag:'Chat'}],onChange:async(value:string)=>{if(query.has('modelError'))throw new Error('Unable to save model');setChatModel(value);calls.push({command:'set_model',args:{value}});}};return <DialogProvider><main style={{height:'100vh',display:'flex',flexDirection:'column',maxWidth:query.has('narrow')?700:undefined,background:'var(--color-base)'}}><nav style={{display:'flex',gap:12,padding:8}}><NavigationMenu label="More" activeLabel="Notebook" value="notebook" items={['Graph','Topics','Split View','Notebook'].map(label=>({label,value:label.toLowerCase()}))} onSelect={()=>{}}/><button onClick={()=>{sharedStudy.cancelAgents(vault);setVault('/other');}}>Switch vault</button></nav><div style={{flex:1,minHeight:0}}>{view==='notebook'?<StudyWorkspace key={vault} vaultPath={vault} config={config} modelPicker={modelPicker} onImport={()=>calls.push({command:'import'})} onOpenNote={()=>calls.push({command:'open_note'})} onOpenSettings={()=>{}} onOtherChatView={()=>setView('assistant')} legacy={<p>Legacy Notebook</p>}/>:<AssistantWorkspace config={config} modelPicker={modelPicker} vaultPath={vault} onConsumed={()=>{}} onNotebook={()=>setView('notebook')} onOpenSettings={()=>{}} advanced={<p>Advanced</p>}/>}</div></main></DialogProvider>;}
createRoot(document.getElementById('root')!).render(<Fixture/>);
