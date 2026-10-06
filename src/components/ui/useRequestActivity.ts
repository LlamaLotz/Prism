import { useCallback, useState } from 'react';
import type { RequestActivity } from '../../services/study';
/** Local adapter for legacy requests that already expose concrete phase callbacks. */
export function useRequestActivity() {
 const [phase,setCurrent]=useState('');const [activity,setActivity]=useState<RequestActivity>();
 const setPhase=useCallback((label:string)=>{setCurrent(label);setActivity(previous=>{if(!label)return previous?{...previous,ended:Date.now(),status:previous.status==='running'?'done':previous.status}:previous;const run=previous?.status==='running'?previous:{id:crypto.randomUUID(),sessionId:'local',started:Date.now(),status:'running' as const,events:[]};return {...run,events:run.events.at(-1)?.label===label?run.events:[...run.events,{label,at:Date.now()}]};});},[]);
 const settle=useCallback((status:'failed'|'cancelled')=>setActivity(previous=>previous?{...previous,status,ended:Date.now()}:previous),[]);
 return {phase,setPhase,activity,settle};
}
