import {test,expect} from '@playwright/test';

test('cloud approval is explicit, scoped, and deny is focused',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html');
 const dialog=page.getByRole('dialog',{name:'Allow external processing?'});
 await expect(dialog).toBeVisible();
 await expect(dialog).toContainText('https://fixture.example');
 await expect(page.getByRole('button',{name:'Deny',exact:true})).toBeFocused();
 await page.getByRole('button',{name:'Deny',exact:true}).click();
 await expect(dialog).not.toBeVisible();
 const calls=await page.evaluate(()=>(window as any).fixtureCalls);
 expect(calls).toContainEqual({command:'resolve_approval',args:{id:'approval-1',approved:false}});
});
test('background job cancellation remains accessible after approval',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html');
 await page.getByRole('button',{name:'Allow this request'}).click();
 await page.getByRole('button',{name:'Jobs (1)',exact:true}).click();
 await expect(page.getByRole('progressbar')).toHaveAttribute('value','0.25');
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByLabel('Background jobs')).toContainText('cancelled');
});

for (const theme of ['industrial','glass','gloss']) for (const mode of ['light','dark']) {
 test(`runtime ${theme} ${mode} navigation and layout`,async({page})=>{
  test.setTimeout(90000);
  await page.goto(`/tests/notebook/runtime-harness.html?theme=${theme}&mode=${mode}&noapproval&states`);
  const jobs=page.getByRole('button',{name:'Jobs (3)',exact:true});
  await jobs.click();
  const panel=page.getByLabel('Background jobs');
  await expect(panel).toContainText('waiting for approval');
  await expect(panel).toContainText('cancelled');
  await expect(panel).toContainText('long-path/');
  const ratios=await panel.evaluate(root=>{
   const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
   const ctx=canvas.getContext('2d')!;
   const rgb=(color:string)=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return Array.from(ctx.getImageData(0,0,1,1).data);};
   const lum=(c:number[])=>c.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
   return Array.from(root.querySelectorAll('h2,strong,.runtime-state,.runtime-error,.runtime-button')).map(el=>{
    const parents:Element[]=[];let node:Element|null=el;while(node){parents.unshift(node);node=node.parentElement;}
    let bg=[255,255,255];for(const parent of parents){const c=rgb(getComputedStyle(parent).backgroundColor);bg=bg.map((v,i)=>c[i]*c[3]/255+v*(1-c[3]/255));}
    const a=lum(rgb(getComputedStyle(el).color)),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
   });
  });
  for(const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({path:`test-results/runtime-${theme}-${mode}.png`});
  await panel.press('Escape');
  await expect(jobs).toBeFocused();
  await page.getByRole('button',{name:'Toggle navigation'}).click();
  await jobs.click();
  await expect(panel).toBeVisible();
  await page.setViewportSize({width:360,height:640});
  await expect.poll(()=>panel.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})).toBe(true);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Close jobs'}).click();
  await expect(jobs).toBeFocused();
  await page.setViewportSize({width:1000,height:1100});
  await page.goto(`/tests/notebook/runtime-harness.html?theme=${theme}&mode=${mode}&noapproval&settings&collapsed`);
  await expect(page.getByRole('heading',{name:'Provider by feature'})).toBeVisible();
  await page.screenshot({path:`test-results/routing-${theme}-${mode}.png`});
  await page.goto(`/tests/notebook/runtime-harness.html?theme=${theme}&mode=${mode}&noapproval&agent&collapsed`);
  await page.getByRole('button',{name:'Agent OFF'}).click();
  await expect(page.getByRole('button',{name:'Approve',exact:true})).toBeVisible();
  await page.screenshot({path:`test-results/agent-${theme}-${mode}.png`});
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.goto(`/tests/notebook/runtime-harness.html?theme=${theme}&mode=${mode}`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.screenshot({path:`test-results/approval-${theme}-${mode}.png`});
 });
}
test('empty jobs stays accessible and cancellation failures are visible',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html?empty&noapproval');
 await page.getByRole('button',{name:'Jobs',exact:true}).click();
 await expect(page.getByLabel('Background jobs')).toContainText('No recent jobs');
 await page.goto('/tests/notebook/runtime-harness.html?noapproval&cancelerror');
 await page.getByRole('button',{name:'Jobs (1)',exact:true}).click();
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Cancellation failed');
});
test('modal approvals trap focus and Escape denies only the current request',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html?multiple&collapsed');
 const deny=page.getByRole('button',{name:'Deny',exact:true});
 await expect(deny).toBeFocused();
 await page.keyboard.press('Shift+Tab');
 await expect(page.getByRole('button',{name:'Allow this request'})).toBeFocused();
 await page.keyboard.press('Tab');
 await expect(deny).toBeFocused();
 await page.keyboard.press('Escape');
 await expect.poll(()=>page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='resolve_approval'))).toEqual([{command:'resolve_approval',args:{id:'approval-1',approved:false}}]);
 await expect(deny).toBeFocused();
 await deny.click();
 await expect(page.getByRole('dialog')).not.toBeVisible();
});
test('feature routes preserve saved providers and explain execution boundaries',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html?noapproval&settings&collapsed&theme=glass&mode=light');
 await expect(page.getByRole('heading',{name:'Provider by feature'})).toBeVisible();
 await expect(page.getByText('Inherit: fixture · default-model').first()).toBeAttached();
 await page.getByLabel('Summarize',{exact:true}).selectOption('saved');
 await page.getByRole('button',{name:'Save settings'}).click();
 await page.reload();
 await expect(page.getByLabel('Summarize',{exact:true})).toHaveValue('saved');
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('runtime-settings')!));
 expect(saved.models.providers[0].id).toBe('saved');
 expect(saved.models.providers[0].config.credentialRef).toBe('keychain-fixture');
 await expect(page.getByText('built-in local',{exact:false})).toBeVisible();
 await expect(page.getByText('configured in Notebook settings',{exact:false})).toBeVisible();
 await expect(page.getByText('A localhost provider may forward to cloud',{exact:false})).toBeVisible();
});
