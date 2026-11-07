import {test, expect, type Page} from '@playwright/test';

async function review(page:Page,query='') {
 await page.goto('/tests/notebook/runtime-harness.html?noapproval&documents&'+query);
 await page.getByRole('button',{name:'Jobs (1)',exact:true}).click();
 await page.getByRole('button',{name:'Review import',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Review document import'})).toBeVisible();
}

for(const theme of ['industrial','gloss']) for(const mode of ['light','dark']) test(`document review ${theme} ${mode}`,async({page})=>{
 await review(page,`theme=${theme}&mode=${mode}&retained&collapsed`);
 const dialog=page.getByRole('dialog',{name:'Review document import'});
 await expect(page.getByRole('button',{name:'Close import review'})).toBeFocused();
 await page.keyboard.press('Shift+Tab');await expect(page.getByRole('button',{name:'Confirm import · 1 notes'})).toBeFocused();
 await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Close import review'})).toBeFocused();
 await expect(dialog).toContainText('Original excerpt 🦀');
 await page.screenshot({path:`test-results/documents-${theme}-${mode}.png`});
 await page.setViewportSize({width:360,height:640});
 await expect.poll(()=>dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&el.scrollWidth<=el.clientWidth;})).toBe(true);
 await page.screenshot({path:`test-results/documents-${theme}-${mode}-narrow.png`});
 await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(page.getByRole('button',{name:'Review import',exact:true})).toBeFocused();
 expect(await page.evaluate(()=>(window as any).fixtureCalls.some((c:any)=>c.command==='commit_document_import'))).toBe(false);
});

test('settings require refreshed preview and confirmation, with whole import undo',async({page})=>{
 await review(page);
 await page.getByLabel('Split document').selectOption('2');
 await page.getByLabel('Keep source in vault').check();
 await expect(page.getByRole('button',{name:/Confirm import/})).toBeDisabled();
 await page.getByRole('button',{name:'Refresh preview',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Output outline · 3 notes'})).toBeVisible();
 await page.getByRole('button',{name:/Exclude .*Section 1/}).click();
 await page.getByRole('button',{name:'Refresh preview',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Output outline · 2 notes'})).toBeVisible();
 await page.getByRole('button',{name:/Confirm import/}).click();
 const dialog=page.getByRole('dialog',{name:'Review document import'});
 await expect(dialog.getByRole('status')).toContainText(/Imported 2 note\(s\)/);
 await expect(dialog).not.toBeVisible({timeout:5000});
 const undo=page.getByRole('status').filter({hasText:/Imported 2 note\(s\)/});
 await expect(undo).toBeVisible();
 await undo.getByRole('button',{name:'Undo',exact:true}).click();
 await expect(undo).not.toBeVisible({timeout:5000});
 const calls=await page.evaluate(()=>(window as any).fixtureCalls);
 expect(calls.find((c:any)=>c.command==='commit_document_import').args.token).toBe('token-2');
 expect(calls.find((c:any)=>c.command==='agent_undo_operation').args.operationId).toBe('document:1');
});

test('conflicts, restart, stale approvals and cancellation never publish automatically',async({page})=>{
 await review(page,'importconflict&restart');
 await expect(page.getByRole('button',{name:/Confirm import/})).toBeDisabled();
 await page.getByLabel('Note name', {exact:true}).fill('Separate import');
 await page.getByLabel('Import a separate copy').check();
 await page.getByRole('button',{name:'Refresh preview',exact:true}).click();
 await expect(page.getByRole('button',{name:/Confirm import/})).toBeEnabled();
 await page.reload();await page.getByRole('button',{name:'Jobs (1)',exact:true}).click();await page.getByRole('button',{name:'Review import',exact:true}).click();
 await expect(page.getByLabel('Note name',{exact:true})).toHaveValue('Separate import');
 await expect(page.getByRole('button',{name:/Confirm import/})).toBeDisabled();
 await page.getByRole('button',{name:'Cancel import',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('stale commit requires a fresh explicit review',async({page})=>{
 await review(page,'staleimport');await page.getByRole('button',{name:/Confirm import/}).click();
 await expect(page.getByRole('alert')).toContainText('CONFLICT');await expect(page.getByRole('button',{name:/Confirm import/})).toBeDisabled();
 await expect(page.getByRole('dialog',{name:'Review document import'})).toBeVisible();
});

test('output and text previews paginate and source details report missing originals',async({page})=>{
 await review(page,'paged&longpreview&missingsource');
 await page.getByRole('button',{name:'Next text'}).first().click();await expect(page.getByLabel(/Markdown preview:/).first()).toHaveText('Remaining source text');
 await page.getByRole('button',{name:'Next outputs',exact:true}).click();await expect(page.getByText(/101–101 of 101/)).toBeVisible();
 await page.getByRole('button',{name:'Close import review'}).click();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Sources',exact:true}).click();await page.getByRole('button',{name:'Source details',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Document source'})).toContainText('page: 2');
 await expect(page.getByRole('dialog',{name:'Document source'})).toContainText('Stored excerpt 日本 🦀');
 await expect(page.getByRole('button',{name:'Open original',exact:true})).toBeDisabled();
});

test('interrupted import rollback is explicit and conflicts preserve recovery data',async({page})=>{
 await review(page,'recovery&recoveryconflict');await expect(page.getByRole('button',{name:/Confirm import/})).toBeDisabled();
 await page.getByRole('button',{name:'Roll back interrupted import'}).click();await expect(page.getByRole('alert')).toContainText('recovery data retained');
});

test('importing indicator disables close and Escape until commit resolves',async({page})=>{
 await review(page,'slowcommit');
 const dialog=page.getByRole('dialog',{name:'Review document import'});
 await page.getByRole('button',{name:/Confirm import/}).click();
 await expect(dialog.getByRole('status')).toContainText(/Importing 1 note\(s\) into the vault/);
 await expect(dialog).toHaveAttribute('aria-busy','true');
 await expect(page.getByRole('button',{name:'Close import review'})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Cancel import',exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:/Confirm import/})).toBeDisabled();
 await page.keyboard.press('Escape');
 await expect(dialog).toBeVisible();
 await expect(dialog).not.toBeVisible({timeout:5000});
});

test('successful import shows confirmation and auto-closes',async({page})=>{
 await review(page);
 const dialog=page.getByRole('dialog',{name:'Review document import'});
 await page.getByRole('button',{name:/Confirm import/}).click();
 await expect(dialog.getByRole('status')).toContainText(/Imported 1 note\(s\)/);
 await expect(dialog).not.toBeVisible({timeout:5000});
 await expect(page.getByRole('status').filter({hasText:/Imported 1 note\(s\)/})).toBeVisible();
});

test('import failure stays open for retry',async({page})=>{
 await review(page,'commitfail');
 const dialog=page.getByRole('dialog',{name:'Review document import'});
 await page.getByRole('button',{name:/Confirm import/}).click();
 await expect(page.getByRole('alert')).toContainText('Publish failed');
 await expect(dialog).toBeVisible();
 await expect(page.getByRole('button',{name:'Close import review'})).toBeEnabled();
 await expect(page.getByRole('button',{name:/Confirm import/})).toBeEnabled();
});

test('batch success shows confirmation and auto-closes',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html?batch&noapproval');
 const dialog=page.getByRole('dialog',{name:'Review batch import'});
 await expect(dialog).toBeVisible();
 await page.getByRole('button',{name:'Commit all ready · 2',exact:true}).click();
 await expect(dialog.getByRole('status')).toContainText(/Imported 2 note\(s\)/);
 await expect(dialog).not.toBeVisible({timeout:5000});
});

test('batch partial failure stays open with results',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html?batch&batchpartial&noapproval');
 const dialog=page.getByRole('dialog',{name:'Review batch import'});
 await page.getByRole('button',{name:'Commit all ready · 2',exact:true}).click();
 await expect(dialog).toBeVisible();
 await expect(dialog.getByRole('status')).toContainText(/Committed 1 import\(s\)/);
 await expect(dialog).toContainText('Skipped.pdf');
 await expect(dialog).toContainText('Broken.pdf');
 await page.waitForTimeout(1200);
 await expect(dialog).toBeVisible();
});
