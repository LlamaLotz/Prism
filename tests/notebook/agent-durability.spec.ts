import {test,expect} from '@playwright/test';
import {mergeAgentContext} from '../../src/services/agentContext';

test('context metadata prefers packed citations, deduplicates and retains degradation',()=>{
 const a={noteId:'n',blockId:'b',path:'/n.md',title:'N',anchor:null,headingPath:[]};
 const first=mergeAgentContext({citations:[],degraded:null},{citations:[{...a,noteId:'paged'}],contextCitations:[a],degraded:'lexical fallback'} as any);
 const next=mergeAgentContext(first,{citations:[a],contextCitations:[a,{...a,blockId:'c'}],degraded:null} as any);
 expect(next.citations.map(c=>c.blockId)).toEqual(['b','c']);expect(next.degraded).toBe('lexical fallback');
 expect(mergeAgentContext(first,{citations:[{...a,blockId:'d'}],degraded:null} as any).citations).toHaveLength(2);
});

test('stale approval requires a fresh preview and durable undo survives reload',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html?noapproval&agent&collapsed&conflict');
 await page.getByRole('button',{name:'Agent OFF'}).click();
 await page.getByRole('button',{name:'Approve',exact:true}).click();
 await expect(page.getByRole('button',{name:'Generate fresh preview'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Approve',exact:true})).not.toBeVisible();
 await page.getByRole('button',{name:'Generate fresh preview'}).click();
 await expect(page.getByText('+ Fresh revision',{exact:false})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='agent_resolve_pending').length)).toBe(1);
 await page.getByRole('button',{name:'Approve',exact:true}).click();
 await expect(page.getByRole('button',{name:'Undo operation'})).toBeVisible();
 await page.reload();await page.getByRole('button',{name:'Agent OFF'}).click();
 await page.getByRole('button',{name:'Undo operation'}).click();
 await expect(page.getByRole('button',{name:'Undo operation'})).not.toBeVisible();
 await page.reload();await page.getByRole('button',{name:'Agent OFF'}).click();
 await expect(page.getByRole('button',{name:'Undo operation'})).not.toBeVisible();
});

test('undo conflicts leave the journal operation available',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html?noapproval&agent&collapsed&undoconflict');
 await page.getByRole('button',{name:'Agent OFF'}).click();await page.getByRole('button',{name:'Approve',exact:true}).click();
 await page.getByRole('button',{name:'Undo operation'}).click();
 await expect(page.getByText('Source changed after the operation.',{exact:false}).first()).toBeVisible();
 await expect(page.getByRole('button',{name:'Undo operation'})).toBeVisible();
});

test('multi-round retrieved sources persist through chat reload and navigate by stable identity',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html?noapproval&agent&collapsed&rounds');
 await page.getByRole('button',{name:'Agent OFF'}).click();
 await page.getByPlaceholder('Ask Prism AI anything...').fill('Compare the sources');
 await page.getByPlaceholder('Ask Prism AI anything...').press('Enter');
 await expect(page.getByText('Final answer from both rounds.')).toBeVisible();
 const chips=page.getByLabel('Retrieved sources');
 await expect(chips.locator('button[title]')).toHaveCount(2);
 await expect(page.getByText('Embeddings unavailable; lexical results used')).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('fixture-transcript') || '[]').find((m:any)=>m.content==='Final answer from both rounds.')?.metadata)).toBeTruthy();
 const saved=await page.evaluate(()=>JSON.parse(JSON.parse(localStorage.getItem('fixture-transcript')!).find((m:any)=>m.content==='Final answer from both rounds.').metadata));
 expect(saved.citations.map((c:any)=>c.noteId)).toEqual(['note-A','note-B']);
 await page.reload();await page.getByRole('button',{name:'Library',exact:true}).click();
 await page.getByText('Compare the sources',{exact:true}).click();
 await expect(page.getByLabel('Retrieved sources').locator('button[title]')).toHaveCount(2);
 await page.getByLabel('Retrieved sources').locator('button[title]').last().click();
 expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='navigate_source'))).toEqual([expect.objectContaining({source:expect.objectContaining({noteId:'note-B',blockId:'block-B'})})]);
});

 test('long operation history stays bounded and exposes explicit recovery',async({page})=>{
  await page.setViewportSize({width:360,height:800});
  await page.goto('/tests/notebook/runtime-harness.html?noapproval&agent&collapsed&manyoperations');
  await page.getByRole('button',{name:'Agent OFF'}).click();
  const history=page.getByLabel('Agent operation history');
  await expect(history.getByRole('button',{name:'Recheck recovery'})).toBeVisible();
  expect(await history.evaluate(el=>el.clientHeight<=180&&el.scrollHeight>el.clientHeight)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.getByPlaceholder('Ask Prism AI anything...').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
  await history.getByRole('button',{name:'Recheck recovery'}).click();
  await expect(history.getByRole('button',{name:'Recheck recovery'})).not.toBeVisible();
  await expect(history.getByRole('button',{name:'Undo operation'})).toHaveCount(10);
 });

 test('agent history dropdown is collapsible and stays within half the chat view',async({page})=>{
  await page.setViewportSize({width:360,height:800});
  await page.goto('/tests/notebook/runtime-harness.html?noapproval&agent&collapsed&manyoperations');
  await page.getByRole('button',{name:'Agent OFF'}).click();
  const toggle=page.getByRole('button',{name:/Agent history/});const drawer=page.locator('.agent-history');const sidebar=page.locator('.ai-sidebar');
  await expect(page.getByLabel('Agent operation history')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded','true');
  const sidebarHeight=await sidebar.evaluate(el=>el.getBoundingClientRect().height);
  const drawerHeight=await drawer.evaluate(el=>el.getBoundingClientRect().height);
  expect(drawerHeight).toBeLessThanOrEqual(sidebarHeight*0.5+1);
  expect(await page.locator('.agent-history-body').evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','false');
  await expect(page.getByLabel('Agent operation history')).not.toBeVisible();
  await toggle.click();await expect(page.getByLabel('Agent operation history')).toBeVisible();
 });
