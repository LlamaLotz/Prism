import { Maximize2, Minimize2, Settings, X } from 'lucide-react';
import type { OmniRouteConfig } from '../../types';
import { useEffect, useState } from 'react';
import { sharedStudy, study, useSharedStudy } from '../../services/study';
import { knowledge } from '../../services/knowledge';
import { SharedChat, type ChatModelPicker } from './SharedChat';
import './study.css';
export function AssistantWorkspace({vaultPath,openRequest,onConsumed,onOpenSettings,config,modelPicker,onVaultChanged,expanded,autoExpanded,onExpand,onCollapse}:{autoExpanded?:boolean;expanded?:boolean;onExpand?:()=>void;onCollapse?:()=>void;vaultPath:string;openRequest?:{sessionId:string;ts:number}|null;onConsumed:()=>void;onOpenSettings:()=>void;config:OmniRouteConfig;modelPicker?:ChatModelPicker;onVaultChanged?:()=>void}){
 const [error,setError]=useState('');useSharedStudy(vaultPath);
 useEffect(()=>{if(!openRequest)return;let alive=true;void(async()=>{try{const rows=await knowledge.listChats(null,null,500);const entry=rows.find(r=>r.id===openRequest.sessionId);if(!entry)throw new Error('Conversation is unavailable');await study.adopt(vaultPath,entry);await sharedStudy.open(vaultPath,entry.id);}catch(e){if(alive)setError(String(e));}finally{if(alive)onConsumed();}})();return()=>{alive=false;};},[vaultPath,openRequest?.ts]);
 return <div className="study-assistant"><div className="study-toolbar"><h2>AI assistant</h2><button onClick={onExpand} disabled={autoExpanded} aria-label={autoExpanded ? 'Chat fills this narrow window' : expanded ? 'Restore sidebar' : 'Expand chat'} title={autoExpanded ? 'Chat fills this narrow window' : expanded ? 'Restore sidebar' : 'Expand chat'}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}</button><button onClick={onCollapse} aria-label="Collapse AI sidebar" title="Close AI sidebar"><X size={16}/></button><button onClick={onOpenSettings} aria-label="AI settings" title="AI settings"><Settings size={16}/></button></div>{error&&<p role="alert">{error}</p>}<SharedChat config={config} modelPicker={modelPicker} onVaultChanged={onVaultChanged} vaultPath={vaultPath} onOpenSettings={onOpenSettings} /></div>;
}
