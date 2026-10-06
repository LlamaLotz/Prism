import { useEffect, useState } from 'react';
import type { RequestActivity } from '../../services/study';
import './AiStatusLine.css';
/** Operational events only. Decorative animation never fades the readable label. */
export function AiStatusLine({phase,activity,className=''}:{phase:string;activity?:RequestActivity;className?:string}) {
 const [now,setNow]=useState(Date.now());
 useEffect(()=>{if(activity?.status!=='running'&&!phase)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[activity?.status,phase]);
 if(!activity&&!phase)return null;
 const elapsed=activity?Math.max(0,Math.floor(((activity.ended??now)-activity.started)/1000)):0;
 const running=activity?activity.status==='running':!!phase;
 const label=activity&&!running?`${activity.status==='done'?'Completed':activity.status==='cancelled'?'Cancelled':'Failed'} in ${elapsed}s`:activity?.events.at(-1)?.label||phase;
 return <details className={`ai-status-line ${className}`} data-running={running} key={activity?.id}>
  <summary><span className="ai-status-line__glyph" aria-hidden="true">✦</span><span className="ai-status-line__label">{label}</span>{running&&activity&&<span className="ai-status-line__time">{elapsed}s</span>}</summary>
  {activity&&<ol>{activity.events.map((event,i)=><li key={i}><span>{event.label}</span><time>{Math.max(0,Math.floor((event.at-activity.started)/1000))}s</time></li>)}</ol>}
 </details>;
}
