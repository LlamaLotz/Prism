import {test,expect} from '@playwright/test';
const url='/tests/notebook/study-harness.html';
for(const theme of ['industrial','glass','gloss'])for(const mode of ['light','dark'])test(`workspace and materials ${theme} ${mode}`,async({page})=>{
 await page.setViewportSize({width:1440,height:960});await page.goto(`${url}?theme=${theme}&mode=${mode}`);await page.getByRole('button',{name:'Open notebook',exact:true}).click();
 await expect(page.getByRole('button',{name:'Thirukkural Structure',exact:false})).toBeVisible();
 await page.screenshot({path:`output/playwright/study-${theme}-${mode}.png`});
 await page.getByRole('button',{name:'More · Notebook'}).click();
 const menu=page.getByRole('menu',{name:'More'});await expect(menu).toBeVisible();
 expect(await menu.getByRole('menuitemradio').first().evaluate(el=>el.getBoundingClientRect().height)).toBeLessThan(44);
 expect(await menu.evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
 await page.screenshot({path:`output/playwright/menu-${theme}-${mode}.png`});
 await menu.press('Escape');await expect(page.getByRole('button',{name:'More · Notebook'})).toBeFocused();
 await page.getByRole('button',{name:'Thirukkural Structure',exact:false}).click();
 const card=page.getByRole('group',{name:'Show answer',exact:true});await expect(card).toBeVisible();
 expect(await card.evaluate(el=>el.getBoundingClientRect().height)).toBeGreaterThan(400);
 await page.screenshot({path:`output/playwright/card-${theme}-${mode}.png`});
 await card.focus();await page.keyboard.press('Space');await expect(page.getByText('Virtue, wealth, and love.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Collapse Tools',exact:true}).click();await page.getByRole('button',{name:'Expand Tools',exact:true}).click();await expect(page.getByText('Virtue, wealth, and love.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Maximize Tools',exact:true}).click();expect(await page.getByRole('group',{name:'Show question',exact:true}).evaluate(el=>el.getBoundingClientRect().width)).toBeGreaterThan(1200);
 await page.getByRole('button',{name:'Restore Tools',exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('layout resizing, persistence and container responsive tabs preserve drafts',async({page})=>{
 await page.goto(url);await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByLabel('Message',{exact:true}).fill('Keep this draft');
 const source=page.locator('[data-panel=sources]');const width=await source.evaluate(e=>e.getBoundingClientRect().width);
 const divider=page.getByRole('separator').first();await divider.focus();await divider.press('ArrowRight');expect(await source.evaluate(e=>e.getBoundingClientRect().width)).toBeGreaterThan(width);
 await page.getByRole('button',{name:'Collapse Sources'}).click();await page.reload();await page.getByRole('button',{name:'Open notebook',exact:true}).click();await expect(page.getByRole('button',{name:'Expand Sources'})).toBeVisible();await page.getByRole('button',{name:'Expand Sources'}).click();
 await page.getByLabel('Message',{exact:true}).fill('Keep this draft');await page.setViewportSize({width:700,height:850});await expect(page.getByRole('navigation',{name:'Notebook areas'})).toBeVisible();
 await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:'Chat',exact:true}).click();await expect(page.getByLabel('Message',{exact:true})).toHaveValue('Keep this draft');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('quiz preserves answers and scores once; flashcard browsing does not schedule reviews',async({page})=>{
 await page.goto(url);await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('button',{name:'Learning check',exact:false}).click();await page.getByRole('radio').first().check();await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('radio').first().check();await page.getByRole('button',{name:'Previous',exact:true}).click();await expect(page.getByRole('radio').first()).toBeChecked();await page.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('button',{name:'Score quiz'}).click();await expect(page.getByText('2 / 2 correct')).toBeVisible();
 await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:'Thirukkural Structure',exact:false}).click();await page.getByLabel('Browse all cards').check();await page.getByRole('button',{name:'Show answer',exact:true}).click();await page.getByRole('button',{name:'Next card'}).click();
 expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.args.action==='review').length)).toBe(0);
 await page.getByLabel('Browse all cards').uncheck();await page.getByRole('button',{name:'Show answer',exact:true}).click();await page.getByRole('button',{name:'Good',exact:true}).click();await expect(page.getByText('1 due · 2 cards')).toBeVisible();
});
test('slides, tables, maps, podcast and editing/export controls remain usable',async({page})=>{
 await page.goto(url);await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('button',{name:'Introduction to the Thirukkural',exact:false}).click();await page.getByRole('button',{name:'Next slide'}).click();await expect(page.getByRole('heading',{name:'Testing fundamentals',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:'Learning comparison',exact:false}).click();await page.getByLabel('Filter rows').fill('Testing');await expect(page.getByRole('cell',{name:'Virtue',exact:true})).not.toBeVisible();
 await page.getByLabel('Material actions').filter({visible:true}).click();await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Title',{exact:true}).filter({visible:true}).fill('Edited table');await page.getByRole('button',{name:'Save changes'}).click();await expect(page.getByRole('heading',{name:'Edited table'})).toBeVisible();
 await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:'Connected ideas',exact:false}).click();await page.getByRole('button',{name:'Zoom in'}).click();await expect(page.getByText('Learning',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:'A conversation about learning',exact:false}).click();await page.getByText('Transcript',{exact:true}).click();await expect(page.getByText('A source-grounded conversation about learning.')).toBeVisible();await page.getByLabel('Material actions').filter({visible:true}).click();await expect(page.getByRole('button',{name:'Export MP3'})).toBeVisible();
});
test('Agent uses collection snapshot and keeps transcript when opening assistant',async({page})=>{
 await page.goto(url);await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('button',{name:'Agent OFF'}).click();await page.getByLabel('Message',{exact:true}).fill('Compare these sources');await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.getByText('Agent answer using selected sources.',{exact:true})).toBeVisible();
 const calls=await page.evaluate(()=>(window as any).fixtureCalls);expect(calls.filter((c:any)=>c.command==='execute_model')).toHaveLength(2);expect(calls.find((c:any)=>c.command==='execute_model').args.request.messages[0].content).toContain('Selected Tamil source');expect(calls.some((c:any)=>c.command==='study_chat')).toBe(false);
 await page.getByLabel('Conversation actions').click();await page.getByRole('button',{name:'Open in other view'}).click();await expect(page.getByText('Agent answer using selected sources.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Agent ON'})).toBeVisible();
});
test('Agent preview requires approval and supports undo',async({page})=>{
 await page.goto(url);await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('button',{name:'Agent OFF'}).click();await page.getByLabel('Message',{exact:true}).fill('{"tool":"edit_note","input":{"noteId":"s1","operations":[]}}');await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).fixtureCalls.some((c:any)=>c.command==='agent_resolve_pending'))).toBe(false);await page.getByRole('button',{name:'Approve',exact:true}).click();await page.getByRole('button',{name:'Undo operation'}).click();await expect(page.getByText('Undid operation on Test.md.')).toBeVisible();
});
test('cancel and vault change prevent subsequent Agent tool calls',async({page})=>{
 for(const action of ['cancel','vault']){await page.goto(url+'?slow');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('button',{name:'Agent OFF'}).click();await page.getByLabel('Message',{exact:true}).fill('Read the source');await page.getByRole('button',{name:'Send',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='execute_model').length)).toBe(1);
 if(action==='cancel')await page.getByRole('button',{name:'Cancel response'}).click();else await page.getByRole('button',{name:'Switch vault'}).click();await page.waitForTimeout(1000);expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='agent_call_tool').length)).toBe(0);}
});
test('generation progress, failure and empty state',async({page})=>{
 await page.goto(url+'?failure');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('button',{name:'Quiz',exact:true}).click();await page.getByRole('button',{name:'Generate',exact:true}).click();await expect(page.getByText('Generating Quiz…',{exact:false})).toBeVisible();await expect(page.getByRole('alert')).toContainText('Generation failed');
 await page.goto(url+'?empty&narrow');await expect(page.getByRole('heading',{name:'Start your first notebook'})).toBeVisible();
});
for(const theme of ['industrial','glass','gloss'])for(const mode of ['light','dark'])test(`narrow notebook ${theme} ${mode}`,async({page})=>{
 await page.setViewportSize({width:420,height:850});await page.goto(`${url}?theme=${theme}&mode=${mode}`);await page.getByRole('button',{name:'Open notebook',exact:true}).click();
 await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:'Thirukkural Structure',exact:false}).click();
 const viewer=page.getByRole('region',{name:'Saved study material'});await expect(viewer).toBeFocused();await page.keyboard.press('Space');await expect(page.getByRole('group',{name:'Show question',exact:true})).toContainText('Virtue, wealth, and love.');
 await page.getByRole('button',{name:'Chat',exact:true}).click();await page.getByRole('button',{name:'Tools',exact:true}).first().click();await expect(page.getByRole('button',{name:'Show question',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await viewer.evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
 await page.screenshot({path:`output/playwright/narrow-${theme}-${mode}.png`});
});
test('source picker, preview, independent scroll and collapsed panel restoration',async({page})=>{
 await page.goto(url);await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('button',{name:'Add sources',exact:true}).click();await page.getByRole('checkbox').last().uncheck();await page.getByRole('button',{name:'Done adding sources'}).click();await expect(page.getByText('1 selected source',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'திருக்குறள் · Virtue and learning Literature',exact:false}).click();await expect(page.getByText('Selected Tamil source. Learning is a lifelong practice.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Sources',exact:true}).click();
 await page.getByRole('button',{name:'Collapse Chat'}).click();await page.getByRole('button',{name:'Collapse Sources'}).click();await expect(page.getByRole('button',{name:'Collapse Tools'})).toBeDisabled();await page.reload();await page.getByRole('button',{name:'Open notebook',exact:true}).click();await expect(page.getByRole('button',{name:'Expand Chat'})).toBeVisible();await expect(page.getByRole('button',{name:'Expand Sources'})).toBeVisible();
 await page.goto(url+'?narrow');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await expect(page.getByRole('navigation',{name:'Notebook areas'})).toBeVisible();
});
test('ordinary chat stays on its path and Agent duplicate sends and denial are safe',async({page})=>{
 await page.goto(url+'?slow');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByLabel('Message',{exact:true}).fill('A normal question');await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.getByText('A grounded answer from your selected sources.')).toBeVisible();
 expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='study_chat').length)).toBe(1);
 await page.getByRole('button',{name:'Agent OFF'}).click();await page.getByLabel('Message',{exact:true}).fill('Read the sources');await page.getByLabel('Message',{exact:true}).press('Enter');await page.getByLabel('Message',{exact:true}).fill('Do not send twice');await page.getByLabel('Message',{exact:true}).press('Enter');await expect(page.getByText('Agent answer using selected sources.',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='append_chat_message'&&c.args.role==='user').length)).toBe(1);
 await page.getByLabel('Message',{exact:true}).fill('{"tool":"edit_note","input":{"noteId":"s1","operations":[]}}');await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByRole('button',{name:'Deny',exact:true}).click();await expect(page.getByRole('button',{name:'Undo operation'})).not.toBeVisible();expect(await page.evaluate(()=>(window as any).fixtureCalls.find((c:any)=>c.command==='agent_resolve_pending').args.approved)).toBe(false);
});
test('agent history is a collapsible dropdown capped at half the chat view',async({page})=>{
 await page.setViewportSize({width:1440,height:960});await page.goto(url+'?history');await page.getByRole('button',{name:'Open notebook',exact:true}).click();
 await page.getByRole('button',{name:'Agent OFF'}).click();
 await page.getByLabel('Message',{exact:true}).fill('{"tool":"edit_note","input":{"noteId":"s1","operations":[]}}');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 const toggle=page.getByRole('button',{name:/Agent history/});const drawer=page.locator('.agent-history');const chat=page.locator('.study-chat');
 await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();
 await expect(toggle).toHaveAttribute('aria-expanded','true');
 const chatHeight=await chat.evaluate(el=>el.getBoundingClientRect().height);
 const drawerHeight=await drawer.evaluate(el=>el.getBoundingClientRect().height);
 expect(drawerHeight).toBeLessThanOrEqual(chatHeight*0.5+1);
 expect(await page.locator('.agent-history-body').evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
 await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','false');await expect(page.getByRole('button',{name:'Approve',exact:true})).not.toBeVisible();
 await toggle.click();await page.getByRole('button',{name:'Deny',exact:true}).click();
 await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','false');
 await page.getByLabel('Message',{exact:true}).fill('{"tool":"edit_note","input":{"noteId":"s1","operations":[]}}');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();
 await expect(toggle).toHaveAttribute('aria-expanded','true');
});
for(const theme of ['industrial','glass','gloss'])for(const mode of ['light','dark'])test(`agent history dropdown ${theme} ${mode}`,async({page})=>{
 await page.setViewportSize({width:1440,height:960});await page.goto(`${url}?theme=${theme}&mode=${mode}&history`);await page.getByRole('button',{name:'Open notebook',exact:true}).click();
 await page.getByRole('button',{name:'Agent OFF'}).click();
 await page.getByLabel('Message',{exact:true}).fill('{"tool":"edit_note","input":{"noteId":"s1","operations":[]}}');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();
 const chatHeight=await page.locator('.study-chat').evaluate(el=>el.getBoundingClientRect().height);
 const drawerHeight=await page.locator('.agent-history').evaluate(el=>el.getBoundingClientRect().height);
 expect(drawerHeight).toBeLessThanOrEqual(chatHeight*0.5+1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:`output/playwright/agent-history-${theme}-${mode}.png`});
});
