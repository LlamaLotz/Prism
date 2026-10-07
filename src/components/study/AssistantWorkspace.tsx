import type { OmniRouteConfig } from '../../types';
import { useEffect, useState, type ReactNode } from 'react';
import { sharedStudy, study, useSharedStudy } from '../../services/study';
import { knowledge } from '../../services/knowledge';
import { SharedChat, type ChatModelPicker } from './SharedChat';
import './study.css';
export function AssistantWorkspace({vaultPath,openRequest,onConsumed,onNotebook,onOpenSettings,advanced,config,modelPicker,onVaultChanged}:{vaultPath:string;openRequest?:{sessionId:string;ts:number}|null;onConsumed:()=>void;onNotebook:()=>void;onOpenSettings:()=>void;advanced:ReactNode;config:OmniRouteConfig;modelPicker?:ChatModelPicker;onVaultChanged?:()=>void}){
 const [legacy,setLegacy]=useState(false);const [error,setError]=useState('');useSharedStudy(vaultPath);
 useEffect(()=>{if(!openRequest)return;let alive=true;void(async()=>{try{const rows=await knowledge.listChats(null,null,500);const entry=rows.find(r=>r.id===openRequest.sessionId);if(!entry)throw new Error('Conversation is unavailable');await study.adopt(vaultPath,entry);await sharedStudy.open(vaultPath,entry.id);if(alive)setLegacy(false);}catch(e){if(alive)setError(String(e));}finally{if(alive)onConsumed();}})();return()=>{alive=false;};},[vaultPath,openRequest?.ts]);
 return <div className="study-assistant"><div className="study-toolbar"><h2>AI assistant</h2><button onClick={()=>setLegacy(v=>!v)}>{legacy?'Shared conversation':'Advanced assistant: agent and web tools'}</button></div>{error&&<p role="alert">{error}</p>}{legacy?advanced:<SharedChat config={config} modelPicker={modelPicker} onVaultChanged={onVaultChanged} vaultPath={vaultPath} onOtherView={onNotebook} onOpenSettings={onOpenSettings} />}</div>;
}
