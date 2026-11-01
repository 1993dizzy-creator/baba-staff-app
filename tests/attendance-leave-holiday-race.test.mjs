import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceFixture, attendanceStubs } from './non-ledger-maintenance-browser.mjs';

const options={skip:!process.env.PLAYWRIGHT_MODULE_PATH};
const holiday=date=>({id:1,holidayDate:date,nameKo:'공휴일',nameVi:'Ngày lễ',internalPayMultiplier:2});
async function waitMonths(page,count) {
  await page.waitForFunction(count=>window.qa.requests.length===count,count);
}
async function settle(page,index,date,failure=false) {
  await page.evaluate(({index,date,failure})=>{
    const request=window.qa.requests[index];
    if(failure)request.reject(new TypeError('late failure'));
    else request.resolve(Response.json({ok:true,holidays:[date]}));
  },{index,date:holiday(date),failure});
}
test('leave holiday markers survive A late success/failure after B; rapid month navigation and departure are safe',options,async()=>{
  const f=await maintenanceFixture('app/(protected)/attendance/leave/page.tsx',{
    ...attendanceStubs,
    '@/lib/auth/client-session': `exports.attendanceFetch=(url)=>url.includes('/holidays?')?window.qa.fetch(url):Promise.resolve(Response.json({ok:true,users:[],records:[]}));`,
  });
  try {for(const failure of [false,true]) {
    const {page}=f;await page.reload();
    await page.evaluate(()=>{window.qa.query='month=2026-10';window.mount();});
    await waitMonths(page,1);
    await page.getByRole('button',{name:'›',exact:true}).click();await waitMonths(page,2);
    await settle(page,1,'2026-11-01');await page.getByText('2X',{exact:true}).waitFor();
    await settle(page,0,'2026-10-01',failure);await page.waitForTimeout(30);
    assert.equal(await page.getByText('2X',{exact:true}).count(),1);
    assert.equal(await page.getByRole('alert').count(),0);
    // B -> C -> D -> C while C's first request is still pending (deduped).
    await page.getByRole('button',{name:'›',exact:true}).click();await waitMonths(page,3);
    await page.getByRole('button',{name:'›',exact:true}).click();await waitMonths(page,4);
    await page.getByRole('button',{name:'‹',exact:true}).click();
    await settle(page,2,'2026-12-01');await page.getByText('2X',{exact:true}).waitFor();
    await settle(page,3,'2027-01-01',failure);await page.waitForTimeout(30);
    assert.equal(await page.getByText('2X',{exact:true}).count(),1);
    // A current-month failure still omits only the optional holiday layer.
    await page.getByRole('button',{name:'›',exact:true}).click();await waitMonths(page,5);
    await settle(page,4,'2027-01-01',true);await page.waitForTimeout(30);
    assert.equal(await page.getByText('2X',{exact:true}).count(),0);
    assert.equal(await page.getByRole('alert').count(),0);
    await page.getByRole('button',{name:'›',exact:true}).click();await waitMonths(page,6);
    await page.evaluate(()=>window.unmount());await settle(page,5,'2027-02-01',failure);
    assert.equal(await page.locator('#root').textContent(),'');
  }} finally {await f.close();}
});
