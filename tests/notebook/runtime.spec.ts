import {test,expect} from '@playwright/test';
import { DEFAULT_SETTINGS } from '../../src/defaultSettings';
import { DEFAULT_GEMINI_MODEL, migrateLegacyGoogleModel } from '../../src/services/settingsMigration';

test.beforeEach(async ({page})=>{
 page.on('pageerror',error=>{throw error;});
});

test('legacy Google model migrates in global settings and saved profiles',()=>{
 const settings=JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as typeof DEFAULT_SETTINGS;
 const googleConfig={provider:'google',apiKey:'',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai/',model:'gemma-4-31b-it',temperature:0.7,injectUserProfile:false,userProfile:''};
 settings.omniRoute={...googleConfig};
 settings.models={...settings.models!,providers:[
  {id:'google-profile',name:'google: gemma-4-31b-it',capabilities:['generation'],config:{...googleConfig}},
  {id:'local-gemma',name:'local gemma',capabilities:['generation'],config:{...googleConfig,baseUrl:'http://localhost:1234/v1'}},
  {id:'renamed-google',name:'google: gemma-4-31b-it',capabilities:['generation'],config:{...googleConfig,model:'gemini-3.8-flash'}},
 ]};
 const migratedResult=migrateLegacyGoogleModel(settings);
 expect(migratedResult.changed).toBe(true);
 expect(migratedResult.settings.omniRoute.model).toBe(DEFAULT_GEMINI_MODEL);
 expect(migratedResult.settings.models!.providers![0].config.model).toBe(DEFAULT_GEMINI_MODEL);
 expect(migratedResult.settings.models!.providers![0].name).toBe(`google: ${DEFAULT_GEMINI_MODEL}`);
 expect(migratedResult.settings.models!.providers![1].config.model).toBe('gemma-4-31b-it');
 expect(migratedResult.settings.models!.providers![2].config.model).toBe(DEFAULT_GEMINI_MODEL);
 expect(migratedResult.settings.models!.providers![2].name).toBe(`google: ${DEFAULT_GEMINI_MODEL}`);
 const again=migrateLegacyGoogleModel(migratedResult.settings);
 expect(again.changed).toBe(false);
 expect(again.settings).toBe(migratedResult.settings);
});

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

for (const theme of ['industrial','gloss']) for (const mode of ['light','dark']) {
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
  await expect(page.getByRole('heading',{name:'Provider by feature'})).not.toBeVisible();
  await page.getByText('Advanced AI settings',{exact:true}).click();
  await expect(page.getByRole('heading',{name:'Provider by feature'})).toBeVisible();
  await page.screenshot({path:`test-results/routing-${theme}-${mode}.png`});
  await page.goto(`/tests/notebook/runtime-harness.html?theme=${theme}&mode=${mode}&noapproval&agent&collapsed`);
  await page.getByRole('button',{name:'Agent OFF'}).click();
  await page.getByRole('button',{name:/Agent history/}).click();
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
 await page.goto('/tests/notebook/runtime-harness.html?noapproval&settings&collapsed&theme=gloss&mode=light');
 await expect(page.getByRole('heading',{name:'Provider by feature'})).not.toBeVisible();
 await page.getByText('Advanced AI settings',{exact:true}).click();
 await expect(page.getByRole('heading',{name:'Provider by feature'})).toBeVisible();
 await expect(page.getByText('Inherit: fixture · default-model').first()).toBeAttached();
 await page.getByLabel('Summarize',{exact:true}).selectOption('saved');
 await page.getByRole('button',{name:'Save settings'}).click();
 await page.reload();
 await expect(page.getByText('Custom routing active')).toBeVisible();
 await expect(page.getByLabel('External content processing')).toBeVisible();
 await expect(page.getByLabel('Summarize',{exact:true})).not.toBeVisible();
 await page.locator('summary').filter({hasText:'Advanced AI settings'}).click();
 await expect(page.getByLabel('Summarize',{exact:true})).toHaveValue('saved');
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('runtime-settings')!));
 expect(saved.models.providers[0].id).toBe('saved');
 expect(saved.models.providers[0].config.credentialRef).toBe('keychain-fixture');
 await expect(page.getByText('built-in local',{exact:false})).toBeVisible();
 await expect(page.getByText('uses the configured generation provider',{exact:false})).toBeVisible();
 await expect(page.getByText('A localhost provider may forward to cloud',{exact:false})).toBeVisible();
});
test('request timeout mode and seconds survive a settings round trip',async({page})=>{
 await page.goto('/tests/notebook/runtime-harness.html?noapproval&settings&collapsed');
 const until=page.getByLabel('Until the AI request fails');
 await expect(until).toBeChecked();
 await expect(page.getByLabel('Custom timeout in seconds')).toBeDisabled();
 await expect(page.getByLabel('Custom timeout in seconds')).toHaveValue('180');
 await page.getByLabel('Custom timeout',{exact:true}).check();
 const seconds=page.getByLabel('Custom timeout in seconds');
 await expect(seconds).toBeEnabled();
 await expect(seconds).toHaveValue('180');
 await seconds.fill('9999');await seconds.blur();await expect(seconds).toHaveValue('3600');
 await seconds.fill('5');await seconds.blur();await expect(seconds).toHaveValue('10');
 await seconds.fill('45');
 await page.getByRole('button',{name:'Save settings'}).click();
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('runtime-settings')!));
 expect(saved.models.requestTimeoutMode).toBe('custom');
 expect(saved.models.requestTimeoutSeconds).toBe(45);
 await page.reload();
 await expect(page.getByLabel('Custom timeout',{exact:true})).toBeChecked();
 await expect(page.getByLabel('Custom timeout in seconds')).toBeEnabled();
 await expect(page.getByLabel('Custom timeout in seconds')).toHaveValue('45');
});
