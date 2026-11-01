import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceFixture, attendanceStubs } from './non-ledger-maintenance-browser.mjs';

const options={skip:!process.env.PLAYWRIGHT_MODULE_PATH};
const user={id:'1',name:'Fixture Employee',username:'fixture',role:'staff',part:'bar',position:null,is_active:true,work_start_time:null,work_end_time:null,levelInfo:null};
const record={id:1,user_id:'1',work_date:'2026-10-01',status:'working',check_in_at:'2026-10-01T09:00:00Z',check_out_at:null,approval_status:null};
const copy={ko:{retry:'다시 시도',empty:'데이터 없음',users:'직원 목록을 불러오지 못했습니다.',records:'근태 기록을 불러오지 못했습니다.',before:'출근전',working:'근무중',stale:'최신 조회에 실패했습니다.'},
  vi:{retry:'Thử lại',empty:'Không có dữ liệu',users:'Không thể tải danh sách nhân viên.',records:'Không thể tải dữ liệu chấm công.',before:'Chưa vào ca',working:'Đang làm',stale:'Lần tải mới nhất không thành công.'}};
async function mount(page,lang) {
  await page.reload();
  await page.evaluate(lang=>{window.qa.lang=lang;window.fetch=(...args)=>window.qa.fetch(...args);window.mount();},lang);
  await page.waitForFunction(()=>window.qa.requests.length===2);
}
async function settle(page,kind,index,data,mode='success') {
  await page.evaluate(({kind,index,data,mode})=>{
    const request=window.qa.requests.filter(r=>r.url.includes('/'+kind))[index];
    if(mode==='network')request.reject(new TypeError('fixture network failure'));
    else if(mode==='json')request.resolve(new Response('<html>',{status:502}));
    else request.resolve(Response.json(data,{status:mode==='http'?500:mode==='401'?401:200}));
  },{kind,index,data,mode});
}
const users=(rows=[user])=>({ok:true,users:rows});
const records=(rows=[])=>({ok:true,records:rows,summaryRevision:'fixture'});

test('staff distinguishes users-only, records-only and combined initial failures from empty results in KO/VI; retries recover',options,async()=>{
  const f=await maintenanceFixture('app/(protected)/attendance/staff/page.tsx',attendanceStubs);
  try {for(const lang of ['ko','vi'])for(const failed of ['users','records','both']) {
    const {page}=f,t=copy[lang];await mount(page,lang);
    await settle(page,'users',0,failed==='records'?users():{ok:false},failed==='records'?'success':'http');
    await settle(page,'records',0,records(),failed==='users'?'success':'json');
    const alert=page.getByRole('alert');await alert.waitFor();
    if(failed!=='records')assert.match(await alert.textContent(),new RegExp(t.users));
    if(failed!=='users')assert.match(await alert.textContent(),new RegExp(t.records));
    assert.equal(await page.getByText(t.empty,{exact:true}).count(),0);
    assert.equal(await page.getByText(t.before,{exact:true}).count(),0);
    assert.equal(await page.getByRole('button').filter({hasText:'Fixture Employee'}).count(),0);
    const initialCount=2;
    await page.getByRole('button',{name:t.retry,exact:true}).click();
    await page.waitForFunction(n=>window.qa.requests.length===n,initialCount+(failed==='both'?2:1));
    assert.equal(await page.getByRole('alert').getByRole('button').isDisabled(),true);
    if(failed!=='records')await settle(page,'users',1,users());
    if(failed!=='users')await settle(page,'records',1,records());
    await page.getByRole('button').filter({hasText:'Fixture Employee'}).waitFor();
    assert.equal(await page.getByRole('alert').count(),0);
    assert.equal(await page.getByText(t.before,{exact:true}).count(),1);
    // A successful empty staff response keeps the existing empty-state wording.
    await mount(page,lang);await settle(page,'users',0,users([]));await settle(page,'records',0,records());
    await page.getByText(t.empty,{exact:true}).waitFor();assert.equal(await page.getByRole('alert').count(),0);
  }} finally {await f.close();}
});

test('staff refresh failures retain prior records with a stale notice; failed retry remains retryable and later success clears it',options,async()=>{
  const f=await maintenanceFixture('app/(protected)/attendance/staff/page.tsx',attendanceStubs);
  try {for(const lang of ['ko','vi']) {
    const {page}=f,t=copy[lang];await mount(page,lang);
    await settle(page,'users',0,users());await settle(page,'records',0,records([record]));
    await page.getByText(t.working,{exact:true}).waitFor();
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(()=>window.qa.requests.length===3);
    await settle(page,'records',1,null,'network');await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(),new RegExp(t.stale));
    assert.equal(await page.getByText(t.working,{exact:true}).count(),1);
    await page.getByRole('button',{name:t.retry,exact:true}).click();
    await page.waitForFunction(()=>window.qa.requests.length===4);
    await settle(page,'records',2,{ok:false},'http');
    await page.getByRole('button',{name:t.retry,exact:true}).waitFor();
    await page.getByRole('button',{name:t.retry,exact:true}).click();
    await page.waitForFunction(()=>window.qa.requests.length===5);
    await settle(page,'records',3,records());await page.getByText(t.before,{exact:true}).waitFor();
    assert.equal(await page.getByRole('alert').count(),0);
    assert.equal(await page.getByText(t.working,{exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.qa.requests.filter(r=>r.url.includes('/users')).length),1);
  }} finally {await f.close();}
});

test('staff keeps the real attendanceFetch 401 flow: bilingual alert, session removal, return path and login redirect',options,async()=>{
  const f=await maintenanceFixture('app/(protected)/attendance/staff/page.tsx',attendanceStubs);
  try {
    const {page}=f,dialogs=[];
    page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
    await page.route('**/login',route=>route.fulfill({contentType:'text/html',body:'<div>Fixture Login</div>'}));
    await page.evaluate(()=>{
      history.replaceState(null,'','/attendance/staff?fixture=1');
      localStorage.setItem('baba_user','fixture');window.fetch=(...args)=>window.qa.fetch(...args);window.mount();
    });
    await page.waitForFunction(()=>window.qa.requests.length===2);
    await settle(page,'users',0,{ok:false},'401');
    await page.waitForURL('**/login');
    assert.equal(dialogs.length,1);assert.match(dialogs[0],/로그인/);assert.match(dialogs[0],/đăng nhập/);
    assert.equal(await page.evaluate(()=>localStorage.getItem('baba_user')),null);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('baba_session_return_path')),'/attendance/staff?fixture=1');
  } finally {await f.close();}
});
