import { test, expect } from '@playwright/test';
import { needsAgent } from '../../src/utils/agentIntent';
test('agent hints distinguish action requests from explanations', () => {
  for (const prompt of ['Please rename this note to Ideas', 'Can you delete the folder Archive?', '{"tool":"read_note","input":{"noteId":"a"}}']) expect(needsAgent(prompt)).toBe(true);
  for (const prompt of ['How do I delete a note?', 'Explain how to rename folders', '"Delete this note" is an example', 'Tell me about gardening']) expect(needsAgent(prompt)).toBe(false);
});
test('agent-off prompt preserves text, cancels, and supports chat override', async ({page}) => {
  await page.goto('/tests/notebook/runtime-harness.html?noapproval&agent&rounds');
  const input = page.getByPlaceholder('Ask Prism AI anything...');
  await input.fill('Please rename this note to Ideas'); await input.press('Enter');
  const dialog = page.getByRole('dialog', {name:'Turn on Agent?'});
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
  await dialog.press('Escape'); await expect(input).toHaveValue('Please rename this note to Ideas'); await expect(input).toBeFocused();
  await input.press('Enter'); await dialog.getByRole('button',{name:'Send as chat'}).click();
  await expect(page.getByRole('button',{name:'Agent OFF'})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='agent_call_tool').length)).toBe(0);
});
test('service recovery waits for explicit retry and never launches a process', async ({page}) => {
  await page.goto('/tests/notebook/runtime-harness.html?noapproval&agent&rounds&service');
  const input=page.getByPlaceholder('Ask Prism AI anything...'); await input.fill('Hello'); await input.press('Enter');
  const dialog=page.getByRole('dialog',{name:'AI service unavailable'});
  await expect(dialog).toContainText('ollama serve');
  await dialog.getByRole('button',{name:'Check again'}).click();
  await expect(dialog.getByRole('button',{name:'Retry request'})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='execute_model').length)).toBe(1);
  await dialog.getByRole('button',{name:'Retry request'}).click();
  await expect(dialog).not.toBeVisible();
  const calls=await page.evaluate(()=>(window as any).fixtureCalls);
  expect(calls.filter((c:any)=>c.command==='execute_model')).toHaveLength(2);
  expect(calls.some((c:any)=>/setup_omniroute|spawn|install/.test(c.command))).toBe(false);
});
test('AI enhancements require review and have undo',async({page})=>{
  await page.goto('/tests/notebook/runtime-harness.html?noapproval&enhancements');
  await page.getByRole('button',{name:'AI tools',exact:true}).click();
  await page.getByRole('button',{name:'AI formatting',exact:true}).click();
  await expect(page.getByText('+ Formatted',{exact:false})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).fixtureCalls.filter((c:any)=>c.command==='agent_resolve_pending'&&c.args?.approved).length)).toBe(0);
  await page.getByRole('button',{name:'Approve changes'}).click();
  await expect(page.getByRole('button',{name:'Undo AI changes'})).toBeVisible();
  await page.getByRole('button',{name:'Undo AI changes'}).click();
  await expect(page.getByRole('button',{name:'Undo AI changes'})).not.toBeVisible();
});
for(const theme of ['industrial','glass','gloss']) for(const mode of ['light','dark']) test(`enhancement geometry ${theme} ${mode}`,async({page})=>{
  await page.setViewportSize({width:420,height:800});
  await page.goto(`/tests/notebook/runtime-harness.html?noapproval&enhancements&collapsed&theme=${theme}&mode=${mode}`);
  await page.getByRole('button',{name:'AI tools',exact:true}).click();
  const button=page.getByRole('button',{name:'AI formatting',exact:true});
  if(theme==='industrial') expect(await button.evaluate(el=>getComputedStyle(el).borderRadius)).toBe('0px');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/enhancements-${theme}-${mode}.png`});
});
