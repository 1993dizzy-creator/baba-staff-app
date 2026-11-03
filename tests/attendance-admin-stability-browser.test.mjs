import assert from 'node:assert/strict';
import test from 'node:test';
import { maintenanceFixture, attendanceStubs } from './non-ledger-maintenance-browser.mjs';

const options = { skip: !process.env.PLAYWRIGHT_MODULE_PATH };
const user = { id: 1, name: 'Fixture Employee', role: 'staff', part: 'bar', work_start_time: '16:00', work_end_time: '01:00', levelInfo: null };
const record = { id: 12, user_id: 1, work_date: '2026-10-01', status: 'working',
  check_in_at: '2026-10-01T09:00:00Z', check_out_at: null, late_minutes: 0, early_leave_minutes: 0, work_minutes: 0, note: 'before' };
const stubs = { ...attendanceStubs,
  'next/navigation': `const React=require('react');exports.useRouter=()=>window.qa.router;
    exports.useParams=()=>{const [userId,setId]=React.useState('1');window.qa.setUserId=setId;return {userId};};exports.useSearchParams=()=>new URLSearchParams(window.qa.query);`,
  '@/lib/auth/client-session': 'exports.attendanceFetch=(...args)=>window.qa.fetch(...args);',
  '@/lib/common/business-time': 'exports.formatVietnamTime=iso=>iso?new Date(iso).toISOString().slice(11,16):"-";',
  '@/components/attendance/useMonthlyAttendanceSummary': `exports.useMonthlyAttendanceSummary=()=>new Map();
    exports.invalidateMonthlyAttendanceSummary=month=>(window.qa.invalidated??=[]).push(month);`,
};
async function mount(page) {
  await page.reload();
  await page.evaluate(() => { window.qa.query = 'month=2026-10&date=2026-10-01'; window.qa.router.push = url => (window.qa.pushed??=[]).push(url); window.mount(); });
  await page.waitForFunction(() => window.qa.requests.length >= 4);
}
async function settleReads(page, failure = false, rows = [record]) {
  await page.evaluate(({failure, rows, user}) => {
    for (const r of window.qa.requests.filter(r => !r.done && !r.init?.method)) {
      r.done = true;
      if (r.url.includes('/records?')) r.resolve(Response.json(failure ? {ok:false} : {ok:true,records:rows}, {status:failure?500:200}));
      else if (r.url.includes('mode=admin_user_month')) r.resolve(Response.json({ok:true,user}));
      else if (r.url.includes('/settings')) r.resolve(Response.json({ok:true,settings:{unauthorized_absence_penalty_days:1}}));
      else r.resolve(Response.json({ok:true,users:[user,{...user,id:2}]}));
    }
  }, {failure, rows, user});
}

test('detail memo keeps missing checkout blank; save locks navigation, invalidates cache and distinguishes refresh failure', options, async () => {
  const f = await maintenanceFixture('app/(protected)/admin/payroll/attendance/[userId]/page.tsx', stubs);
  try {
    const {page} = f;
    await mount(page); await settleReads(page);
    const times = page.locator('input[type="datetime-local"]');
    await times.nth(1).waitFor(); assert.equal(await times.nth(1).inputValue(), '');
    await page.locator('textarea').fill('memo only');
    await page.getByRole('button', {name:'수정 저장', exact:true}).click();
    const payload = await page.evaluate(() => JSON.parse(window.qa.requests.find(r => r.init?.method === 'POST').init.body));
    assert.equal(payload.note, 'memo only');
    assert.equal('check_out_datetime' in payload, false); assert.equal('check_in_datetime' in payload, false);
    assert.equal(await page.getByRole('button', {name:'다음 직원', exact:true}).isDisabled(), true);
    assert.equal(await page.getByRole('button', {name:'›', exact:true}).isDisabled(), true);
    assert.equal(await page.locator('textarea').isDisabled(), true);
    await page.evaluate(record => window.qa.requests.find(r => r.init?.method === 'POST').resolve(Response.json({ok:true,record:{...record,note:'memo only',updated_at:'2026-11-04T00:00:00Z'}})), record);
    await page.waitForFunction(() => window.qa.requests.filter(r => r.url.includes('/records?')).length === 2);
    await settleReads(page, true);
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('status').textContent(), /저장은 완료.*재조회에 실패/);
    assert.deepEqual(await page.evaluate(() => window.qa.invalidated), ['2026-10']);
    await page.getByRole('button', {name:'다시 조회', exact:true}).click();
    await page.waitForFunction(() => window.qa.requests.filter(r => r.url.includes('/records?')).length === 3);
    await settleReads(page, false, [{...record,note:'memo only'}]);
    await times.nth(1).waitFor(); assert.equal(await times.nth(1).inputValue(), '');
    await page.getByRole('button', {name:'예정 퇴근시간 적용', exact:true}).click();
    assert.equal(await times.nth(1).inputValue(), '2026-10-02T01:00');
  } finally { await f.close(); }
});

test('detail failure is retryable; old employee responses cannot replace the selected scope', options, async () => {
  const f = await maintenanceFixture('app/(protected)/admin/payroll/attendance/[userId]/page.tsx', stubs);
  try {
    const {page} = f;
    await mount(page); await settleReads(page, true);
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('textarea').count(), 0);
    await page.getByRole('button', {name:'다시 조회', exact:true}).click();
    await page.waitForFunction(() => window.qa.requests.filter(r => r.url.includes('/records?')).length === 2);
    await settleReads(page); await page.locator('textarea').waitFor();
    await page.getByRole('button', {name:'›', exact:true}).click();
    await page.waitForFunction(() => window.qa.requests.some(r => r.url.includes('month=2026-11')));
    // Simulate an external route transition while the prior employee's reads are pending.
    await page.evaluate(() => {
      window.qa.older = window.qa.requests.filter(r => !r.done);
      for(const r of window.qa.older) r.done = true;
      window.qa.setUserId('2');
    });
    await page.waitForFunction(() => window.qa.requests.some(r => r.url.includes('user_id=2')));
    await settleReads(page, false, []);
    await page.getByRole('button', {name:'›', exact:true}).waitFor();
    await page.getByText('해당 날짜의 근태 기록이 없습니다.',{exact:false}).waitFor();
    await page.evaluate(({user,record}) => {
      for(const r of window.qa.older) r.resolve(Response.json(r.url.includes('/records?')?{ok:true,records:[record]}:{ok:true,user,users:[user]}));
    },{user,record:{...record,work_date:'2026-11-01'}});
    await page.waitForTimeout(30);
    assert.equal(await page.getByRole('button',{name:'수정 저장',exact:true}).count(), 0);
  } finally { await f.close(); }
});

test('overview separates failed reads from empty; Jan 31 navigation reaches February and rejects late responses', options, async () => {
  const f = await maintenanceFixture('app/(protected)/admin/payroll/attendance/page.tsx', {
    ...stubs, '@/components/attendance/AttendanceBonusProgressBadge': 'module.exports=()=>null;',
  });
  try {
    const {page} = f;
    await page.clock.install({time:new Date('2026-01-31T05:00:00Z')});
    await page.evaluate(() => { window.qa.query='month=2026-01'; window.mount(); });
    await page.waitForFunction(() => window.qa.requests.length === 3);
    await page.evaluate(() => { for(const r of window.qa.requests) r.resolve(Response.json(r.url.endsWith('/admin')?{ok:true}:{ok:false},{status:r.url.endsWith('/admin')?200:500})); });
    await page.getByRole('alert').waitFor();
    await page.getByRole('button',{name:'다시 조회',exact:true}).click();
    await page.waitForFunction(() => window.qa.requests.length === 5);
    await page.getByRole('button',{name:'›',exact:true}).click();
    await page.waitForFunction(() => window.qa.requests.length === 7);
    assert.equal(await page.evaluate(() => window.qa.requests[5].url.includes('month=2026-02')), true);
    await page.evaluate(() => { for(const r of window.qa.requests.slice(5)) r.resolve(Response.json({ok:true,users:[],records:[]})); });
    await page.getByText('데이터 없음',{exact:true}).waitFor();
    await page.evaluate(user => { for(const r of window.qa.requests.slice(3,5)) r.resolve(Response.json({ok:true,users:[user],records:[]})); }, user);
    await page.waitForTimeout(30);
    assert.equal(await page.getByText('Fixture Employee',{exact:true}).count(), 0);
    assert.equal(await page.getByRole('alert').count(), 0);
  } finally { await f.close(); }
});
