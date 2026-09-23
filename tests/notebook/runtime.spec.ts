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
