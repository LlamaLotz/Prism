import { test, expect } from '@playwright/test';
import { openConversationMenu, toggleAgent } from './assistant-menu';
import { RepetitionGuard,extractToolCalls,runAgentTurn } from '../../src/services/agentRunner';
import { knowledge } from '../../src/services/knowledge';
import { noteGraph,withFolders } from '../../src/services/folderGraph';
test('folder graph keeps path identities, empty folders and original note degrees',()=>{
 const original=noteGraph({nodes:[{id:'/vault/A/Note.md',title:'Note',exists:true},{id:'/vault/B/Note.md',title:'Note',exists:true},{id:'/vault/Loose.md',title:'Loose',exists:true}],links:[{source:'/vault/A/Note.md',target:'/vault/B/Note.md'}]},'/vault');
 const graph=withFolders(original,['A','B','Empty/Nested']);expect(graph.nodes.filter(n=>n.kind!=='folder')).toHaveLength(3);expect(graph.nodes.find(n=>n.id==='folder:Empty/Nested')).toBeTruthy();expect(graph.links).toContainEqual({source:'folder:Empty',target:'folder:Empty/Nested',kind:'contains'});expect(original.nodes.map(n=>n.linksCount)).toEqual([1,1,0]);
 // The vault root is the canvas, not a folder node: nothing may reference it.
 expect(graph.nodes.some(n=>n.id==='folder:')).toBe(false);expect(graph.links.some(l=>l.source==='folder:'||l.target==='folder:')).toBe(false);expect(graph.links).toContainEqual({source:'folder:A',target:'A/Note.md',kind:'contains'});expect(graph.links.some(l=>l.target==='Loose.md'&&l.kind==='contains')).toBe(false);
});
test('repetition requires six redundant calls and two active minutes, handles cycles',()=>{
 const guard=new RepetitionGuard();expect(guard.observe('read',{a:1},{text:'a'},0)).toBe(false);expect(guard.observe('read',{b:1},{text:'b'},1000)).toBe(false);
 for(let i=0;i<5;i++)expect(guard.observe('read',i%2?{b:1}:{a:1},i%2?{text:'b'}:{text:'a'},121000)).toBe(false);
 expect(guard.observe('read',{b:1},{text:'b'},121000)).toBe(true);
 expect(guard.observe('edit',{}, {approved:true},122000,true)).toBe(false);
 const waiting=new RepetitionGuard();waiting.observe('read',{},'same',0);waiting.excludeWait(200000);for(let i=0;i<10;i++)expect(waiting.observe('read',{},'same',210000)).toBe(false);
});
test('agent completes more than five productive rounds and continues after approval',async()=>{
 const previous=knowledge.agentCall;let calls=0;const posts:string[]=[];
 knowledge.agentCall=async tool=>({tool,requiresApproval:tool==='edit_note',approvalId:tool==='edit_note'?'approval':null,preview:'change',result:{page:++calls},error:null});
 try{let round=0;await runAgentTurn({messages:[{role:'user',content:'Do the task'}],complete:async()=>++round<=8?'```json\n'+JSON.stringify({tool:round===3?'edit_note':'read_note',input:{page:round}})+'\n```':'Done',post:text=>{posts.push(text);},approval:async()=>({approved:true})});expect(calls).toBe(8);expect(posts.at(-1)).toBe('Done');}finally{knowledge.agentCall=previous;}
});
test('tool calls parse fenced and whole-message JSON but not prose examples',()=>{
 const call={tool:'create_note',input:{path:'A.md',content:'x'}};
 expect(extractToolCalls(JSON.stringify(call))).toEqual([call]);
 expect(extractToolCalls('```json\n'+JSON.stringify(call)+'\n```')).toEqual([call]);
 expect(extractToolCalls(JSON.stringify([call,call]))).toEqual([call,call]);
 expect(extractToolCalls('For example, {"tool":"create_note","input":{}} is the shape.')).toEqual([]);
 expect(extractToolCalls('Here you go:\n'+JSON.stringify(call))).toEqual([]);
});
test('bare JSON create_note calls are approved instead of posted as text',async()=>{
 const previous=knowledge.agentCall;const calls:Array<{tool:string;input:unknown}>=[];const approved:unknown[]=[];const posts:string[]=[];
 knowledge.agentCall=async(tool,input)=>{calls.push({tool,input});return {tool,requiresApproval:true,approvalId:'raw-approval',preview:'note',result:null,error:null};};
 try{
  const request={tool:'create_note',input:{path:'Equitable AI Use.md',content:'# Equitable Use'}};
  let round=0;
  await runAgentTurn({messages:[{role:'user',content:'create me a note'}],complete:async()=>++round===1?JSON.stringify(request):'Done',post:text=>{posts.push(text);},approval:async response=>{approved.push(response);return {approved:true};}});
  expect(calls).toEqual([request]);
  expect(approved).toHaveLength(1);
  expect(posts.at(-1)).toBe('Done');
  expect(posts.some(text=>text.includes('"tool"'))).toBe(false);
 }finally{knowledge.agentCall=previous;}
});
test('models belong to individual conversations and auto approval continues the task',async({page})=>{
 await page.goto('/tests/notebook/study-harness.html');await page.getByRole('button',{name:'Open notebook',exact:true}).click();
 await page.getByRole('combobox',{name:'Chat model'}).click();await page.getByRole('option',{name:/Other model/}).click();
 await openConversationMenu(page);await page.getByRole('button',{name:'Agent ON',exact:true}).click();
 await page.getByLabel('Message',{exact:true}).fill('Hello');await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.getByText('A grounded answer from your selected sources.')).toBeVisible();
 await page.getByRole('button',{name:'New chat',exact:true}).click();await expect(page.getByRole('combobox',{name:'Chat model'})).toContainText('Fixture model');
 await toggleAgent(page);await page.getByRole('button',{name:'Approve for me OFF'}).click();await page.getByLabel('Message',{exact:true}).fill('{"tool":"edit_note","input":{"noteId":"s1","operations":[]}}');await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByText('Agent answer using selected sources.',{exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='agent_resolve_pending'&&c.args.approved).length)).toBe(1);
 await page.locator('.ai-status-line summary').click();await expect(page.getByText('Applied Test.md',{exact:true})).toBeVisible();
});
test('auto-approved apply failures are surfaced and mark the turn failed',async({page})=>{
 await page.goto('/tests/notebook/study-harness.html?applyFailure');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await toggleAgent(page);
 await page.getByRole('button',{name:'Approve for me OFF'}).click();await page.getByLabel('Message',{exact:true}).fill('{"tool":"edit_note","input":{"noteId":"s1","operations":[]}}');await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'could not be indexed'})).toBeVisible();
 await expect(page.getByText(/Failed in \d+s/)).toBeVisible();
 await expect(page.getByText(/Completed in \d+s/)).toHaveCount(0);
});
test('manual approval waits for the reviewer and applies the change',async({page})=>{
 await page.goto('/tests/notebook/study-harness.html');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await toggleAgent(page);
 await page.getByLabel('Message',{exact:true}).fill('{"tool":"edit_note","input":{"noteId":"s1","operations":[]}}');await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='agent_resolve_pending').length)).toBe(0);
 await page.getByRole('button',{name:'Approve',exact:true}).click();
 await expect(page.getByText('Agent answer using selected sources.',{exact:true})).toBeVisible();
 await expect(page.getByText(/Completed in \d+s/)).toBeVisible();
 expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='agent_resolve_pending'&&c.args.approved).length)).toBe(1);
});
test('timeout ends in Timed out and removes the running dots',async({page})=>{
 await page.goto('/tests/notebook/study-harness.html?timeout');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await toggleAgent(page);
 await page.getByLabel('Message',{exact:true}).fill('Check the selected sources');await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByText(/Timed out in \d+s/)).toBeVisible();
 await expect(page.locator('.ai-status-line__dots')).toHaveCount(0);
 await expect(page.getByRole('alert').filter({hasText:'timed out'})).toBeVisible();
});
test('running dots exist only while a slow model request is in flight',async({page})=>{
 await page.goto('/tests/notebook/study-harness.html?slow');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await toggleAgent(page);
 await page.getByLabel('Message',{exact:true}).fill('Check the selected sources');await page.getByRole('button',{name:'Send',exact:true}).click();
 const dots=page.locator('.ai-status-line__dots');await expect(dots).toBeVisible();
 await expect(page.getByText('Agent answer using selected sources.',{exact:true})).toBeVisible();
 await expect(dots).toHaveCount(0);await expect(page.locator('.ai-status-line__glyph')).toBeVisible();
});
test('reduced motion keeps status dots legible without animation',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/tests/notebook/study-harness.html?slow');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await toggleAgent(page);
 await page.getByLabel('Message',{exact:true}).fill('Check the selected sources');await page.getByRole('button',{name:'Send',exact:true}).click();
 const dots=page.locator('.ai-status-line__dots');await expect(dots).toBeVisible();
 expect(await dots.locator('i').first().evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
 await expect(page.getByText('Agent answer using selected sources.',{exact:true})).toBeVisible();
});
