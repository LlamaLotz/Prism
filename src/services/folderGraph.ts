import type { GraphNode, GraphLink, GraphPayload } from '../types';
export function noteGraph(payload:GraphPayload,root=''):{nodes:GraphNode[];links:GraphLink[]} {
 const relative=(path:string)=>{const normalized=path.replaceAll('\\','/');const prefix=root.replaceAll('\\','/').replace(/\/$/,'')+'/';return root&&normalized.startsWith(prefix)?normalized.slice(prefix.length):normalized;};
 payload={nodes:payload.nodes.map(n=>({...n,id:relative(n.id)})),links:payload.links.map(e=>({source:relative(e.source),target:relative(e.target)}))};
 const nodes=payload.nodes.map(n=>({...n,linksCount:0}));const paths=new Map(nodes.map(n=>[n.id.toLowerCase(),n]));
 const titles=new Map<string,GraphNode[]>();for(const n of nodes)titles.set(n.title.toLowerCase(),[...(titles.get(n.title.toLowerCase())??[]),n]);
 const resolve=(id:string)=>paths.get(id.toLowerCase())??(titles.get(id.toLowerCase())?.length===1?titles.get(id.toLowerCase())![0]:undefined);
 const links:GraphLink[]=[];const seen=new Set<string>();
 for(const edge of payload.links){const source=resolve(edge.source);if(!source)continue;let target=resolve(edge.target);if(!target){target={id:edge.target,title:edge.target,exists:false,linksCount:0};nodes.push(target);paths.set(target.id.toLowerCase(),target);}if(source===target)continue;const key=[source.id,target.id].sort().join('\0');if(seen.has(key))continue;seen.add(key);source.linksCount++;target.linksCount++;links.push({source:source.id,target:target.id});}
 return {nodes,links};
}
export const folderId=(path:string)=>`folder:${path}`;
export function withFolders(graph:{nodes:GraphNode[];links:GraphLink[]},folders:string[]) {
 // Real folders only: the vault root is the canvas, not a folder node, so
 // top-level folders and root-level notes simply have no containing edge.
 const paths=new Set<string>();const add=(path:string)=>{const parts=path.split('/').filter(Boolean);while(parts.length){paths.add(parts.join('/'));parts.pop();}};
 folders.forEach(add);graph.nodes.filter(n=>n.exists).forEach(n=>add(n.id.split('/').slice(0,-1).join('/')));
 const nodes:GraphNode[]=graph.nodes.map(n=>({...n}));const links:GraphLink[]=graph.links.map(e=>({...e,source:typeof e.source==='object'?(e.source as GraphNode).id:e.source,target:typeof e.target==='object'?(e.target as GraphNode).id:e.target}));
 const parentOf=(path:string)=>path.split('/').slice(0,-1).join('/');
 for(const path of paths){const parent=parentOf(path);nodes.push({id:folderId(path),title:`📁 ${path}`,exists:true,linksCount:0,kind:'folder',folderPath:path});if(parent)links.push({source:folderId(parent),target:folderId(path),kind:'contains'});}
 for(const node of graph.nodes){const parent=parentOf(node.id);if(node.exists&&parent)links.push({source:folderId(parent),target:node.id,kind:'contains'});}
 return {nodes,links};
}
