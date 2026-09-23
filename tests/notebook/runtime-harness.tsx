import React from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeActivity } from '../../src/components/RuntimeActivity';
import '../../src/index.css';
const calls: unknown[] = [];
let approvals = [{id:'approval-1', destination:'https://fixture.example',task:'NOTEBOOK',scope:'2 messages, 120 bytes',payloadHash:'fixture',vaultId:'vault-1'}];
const jobs = [{id:'job-1',kind:'EMBED',state:'running',priority:10,progress:0.25,error:null}];
Object.assign(window,{fixtureCalls:calls});
Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:Record<string,unknown>={})=>{
 calls.push({command,args});
 if(command==='list_approvals')return approvals;
 if(command==='list_knowledge_jobs')return jobs;
 if(command==='resolve_approval'){approvals=approvals.filter(a=>a.id!==args.id);return;}
 if(command==='cancel_knowledge_job'){jobs[0].state='cancelled';return;}
 if(command.startsWith('plugin:'))return 1;
 throw new Error(command);
}}});
createRoot(document.getElementById('root')!).render(<RuntimeActivity/>);
