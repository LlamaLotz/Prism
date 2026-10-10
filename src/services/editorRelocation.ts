import { moveWithPendingSaves } from './noteIO';
// The mounted editor flushes its draft and retargets delayed saves atomically with a move.
type Relocate = (oldPath:string,newPath:string,move:()=>Promise<void>)=>Promise<string|undefined>;
let editor:Relocate|undefined;
export function registerEditorRelocation(handler:Relocate){editor=handler;return()=>{if(editor===handler)editor=undefined;};}
export async function relocateNote(oldPath:string,newPath:string,move:()=>Promise<void>){const relocate=()=>moveWithPendingSaves(oldPath,newPath,move);if(editor)return editor(oldPath,newPath,relocate);await relocate();}
