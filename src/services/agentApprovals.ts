import { knowledge } from './knowledge';
type Resolution=Awaited<ReturnType<typeof knowledge.agentApprove>>;
const waiting=new Map<string,{resolve:(r:Resolution)=>void;reject:(e:unknown)=>void}>();
export function waitForAgentApproval(id:string,signal:AbortSignal):Promise<Resolution>{return new Promise((resolve,reject)=>{
 const cancel=()=>{waiting.delete(id);reject(new Error('Agent cancelled'));};
 if(signal.aborted){cancel();return;}
 signal.addEventListener('abort',cancel,{once:true});
 waiting.set(id,{resolve:r=>{signal.removeEventListener('abort',cancel);waiting.delete(id);resolve(r);},reject:e=>{signal.removeEventListener('abort',cancel);waiting.delete(id);reject(e);}});
});}
export async function resolveAgentApproval(id:string,approved:boolean){try{const result=await knowledge.agentApprove(id,approved);waiting.get(id)?.resolve(result);return result;}catch(e){waiting.get(id)?.reject(e);throw e;}}
