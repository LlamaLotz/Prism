import { test, expect } from '@playwright/test';
const url='/tests/notebook/study-harness.html?library';
for(const theme of ['industrial','glass','gloss'])for(const mode of ['light','dark'])test(`library geometry and contrast ${theme} ${mode}`,async({page})=>{
 await page.goto(`${url}&theme=${theme}&mode=${mode}`);
 await expect(page.getByRole('heading',{name:'Notebooks',exact:true})).toBeVisible();
 await page.screenshot({path:`output/playwright/library-${theme}-${mode}.png`});
 const covers=page.getByRole('group',{name:'Notebook covers'});await covers.focus();await covers.press('ArrowRight');
 await expect(page.locator('.notebook-library__caption h2')).toHaveText('Research notebook 1');
 if(theme!=='industrial')expect(await page.locator('.notebook-cover').first().evaluate(e=>getComputedStyle(e).transform)).toContain('matrix3d');
 const ratios=await page.locator('.notebook-library').evaluate(el=>{const style=getComputedStyle(el);const linear=(s:string)=>{const parts=s.match(/[\d.]+/g)!.slice(0,3).map(Number).map(c=>{const v=c/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return parts[0]*.2126+parts[1]*.7152+parts[2]*.0722};const probe=document.createElement('span');el.append(probe);const value=(name:string)=>{probe.style.color=`var(${name})`;return linear(getComputedStyle(probe).color);};const bg=value('--nb-panel');const ratios=['--nb-text','--nb-secondary'].map(n=>{const fg=value(n);return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)});probe.remove();return ratios;});
 expect(Math.min(...ratios)).toBeGreaterThanOrEqual(4.5);
 await covers.press('Enter');await expect(page.getByRole('button',{name:'Back to notebooks'})).toBeVisible();await page.getByRole('button',{name:'Back to notebooks'}).click();await expect(page.locator('.notebook-library__caption h2')).toHaveText('Research notebook 1');
 await page.getByRole('button',{name:'Grid',exact:true}).click();await page.getByLabel('Search notebooks').fill('அறத்துப்பால்');await expect(page.locator('.notebook-cover:visible')).toHaveCount(1);await page.locator('.notebook-cover:visible').click();await expect(page.getByLabel('Collection',{exact:true})).toHaveValue('book2');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('navigation retains a flipped card, quiz answers, and unsaved edits',async({page})=>{
 await page.goto(url);await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('button',{name:/Thirukkural Structure/}).click();await page.getByRole('button',{name:'Show answer',exact:true}).click();await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:/Learning check/}).click();await page.getByRole('radio').first().check();await page.getByRole('button',{name:'Back to notebooks'}).click();await page.getByRole('button',{name:'Open notebook',exact:true}).click();await expect(page.getByRole('radio').first()).toBeChecked();await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:/Thirukkural Structure/}).click();await expect(page.getByRole('group',{name:'Show question'})).toBeVisible();
});
test('model failure retains selection and requests capture the chosen provider',async({page})=>{
 await page.goto(url+'&modelError');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('combobox',{name:'Chat model'}).click();await page.getByRole('option',{name:/Other model/}).click();await expect(page.getByRole('alert')).toContainText('Unable to save model');await expect(page.getByRole('combobox',{name:'Chat model'})).toContainText('Fixture model');
 await page.goto(url);await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('combobox',{name:'Chat model'}).click();await page.getByRole('option',{name:/Other model/}).click();await page.getByLabel('Message',{exact:true}).fill('Explain');await page.getByRole('button',{name:'Send',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).fixtureCalls.find((c:any)=>c.command==='study_chat')?.args.providerId)).toBe('m2');
});
test('narrow library and long flashcard text remain usable with reduced motion',async({page})=>{
 await page.setViewportSize({width:480,height:600});await page.emulateMedia({reducedMotion:'reduce'});await page.goto(url+'&theme=gloss&mode=light');await page.getByRole('button',{name:'Open notebook',exact:true}).click();await page.getByRole('button',{name:'Tools',exact:true}).click();await page.getByRole('button',{name:/Thirukkural Structure/}).click();await page.getByRole('group',{name:'Show answer'}).press('Space');await expect(page.getByText('Virtue, wealth, and love.',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'output/playwright/library-narrow-flashcard.png'});
});
