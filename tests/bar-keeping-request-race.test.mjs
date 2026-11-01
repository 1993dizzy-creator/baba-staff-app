import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceFixture } from './non-ledger-maintenance-browser.mjs';

const options={skip:!process.env.PLAYWRIGHT_MODULE_PATH};
const result=(id,cursor=null,manage=false)=>({items:[{id}],hasMore:!!cursor,nextCursor:cursor,capabilities:{manage}});
async function settle(page,index,data,failure=false) {
  await page.evaluate(({index,data,failure})=>{
    const request=window.qa.requests.filter(r=>!r.url.includes('/counts'))[index];
    if(failure)request.reject(new Error('late failure'));else request.resolve(Response.json(data));
  },{index,data,failure});
}
async function count(page,n) {
  await page.waitForFunction(n=>window.qa.requests.filter(r=>!r.url.includes('/counts')).length===n,n);
}
test('keeping rejects stale pagination success/failure after search, sort or status changes; latest loading and cursor survive',options,async()=>{
  const f=await maintenanceFixture('app/(protected)/bar/keeping/page.tsx');
  try {for(const change of ['search','sort','status'])for(const failure of [false,true]) {
    const {page}=f;
    await page.reload(); await page.evaluate(()=>{window.qa.pathname='/bar/keeping';window.mount();});
    await count(page,1); await settle(page,0,result('old','old-cursor',true));
    await page.locator('[data-item="old"]').waitFor();
    // Two queued clicks on the same render must make only one request.
    await page.getByRole('button',{name:'더 보기',exact:true}).evaluate(button=>{button.click();button.click();});
    await count(page,2);
    if(change==='search')await page.getByRole('textbox').fill('new');
    if(change==='sort')await page.getByRole('combobox').selectOption('old_activity');
    if(change==='status')await page.getByRole('tab').nth(1).click();
    await count(page,3);
    await page.locator('[aria-busy="true"]').waitFor();
    await settle(page,1,result('stale','stale-cursor',true),failure);
    // Old finally cannot stop the new loading state or expose old pagination.
    assert.equal(await page.locator('[aria-busy="true"]').count(),1,`${change}, failure=${failure}`);
    assert.equal(await page.locator('[data-item="stale"]').count(),0);
    assert.equal(await page.getByRole('link').count(),0);
    await settle(page,2,result('new','new-cursor'));
    await page.locator('[data-item="new"]').waitFor();
    assert.equal(await page.locator('[data-item="old"]').count(),0);
    await page.getByRole('button',{name:'더 보기',exact:true}).click();await count(page,4);
    assert.match(await page.evaluate(()=>window.qa.requests.filter(r=>!r.url.includes('/counts'))[3].url),/cursor=new-cursor/);
    await settle(page,3,result('append'));await page.locator('[data-item="append"]').waitFor();
    assert.equal(await page.locator('[data-item]').count(),2);
  }} finally {await f.close();}
});

test('keeping latest response wins reversed initial/JSON completion; retry and unmount invalidate all pending requests',options,async()=>{
  const f=await maintenanceFixture('app/(protected)/bar/keeping/page.tsx');
  try {
    const {page}=f;
    await page.evaluate(()=>{window.mount();});await count(page,1);
    // Transport has completed, but response body decoding is still pending.
    await page.evaluate(()=>window.qa.requests[0].resolve({ok:true,status:200,json:()=>new Promise(resolve=>window.qa.resolveBody=resolve)}));
    await page.waitForFunction(()=>!!window.qa.resolveBody);
    await page.getByRole('combobox').selectOption('old_activity');await count(page,2);
    await settle(page,1,result('latest','latest-cursor'));await page.locator('[data-item="latest"]').waitFor();
    await page.evaluate(data=>window.qa.resolveBody(data),result('stale','bad',true));
    await page.waitForTimeout(30);assert.equal(await page.locator('[data-item="stale"]').count(),0);
    await page.getByRole('button',{name:'더 보기',exact:true}).click();await count(page,3);
    await settle(page,2,null,true);
    await page.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
    await page.getByRole('button',{name:'다시 시도',exact:true}).evaluate(button=>{button.click();button.click();});
    await count(page,5);
    await settle(page,4,result('retried'));await page.locator('[data-item="retried"]').waitFor();
    await settle(page,3,null,true);await page.waitForTimeout(30);
    assert.equal(await page.locator('[data-item="retried"]').count(),1);
    await page.getByRole('combobox').selectOption('recent_activity');await count(page,6);
    await page.evaluate(()=>window.unmount());await settle(page,5,result('unmounted'));
    assert.equal(await page.locator('[data-item]').count(),0);
  } finally {await f.close();}
});
