import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { maintenanceFixture, attendanceStubs } from './non-ledger-maintenance-browser.mjs';

const options = { skip: !process.env.PLAYWRIGHT_MODULE_PATH };
const users = [
  { id: 1, name: 'Calendar Employee', role: 'staff', part: 'bar', work_start_time: '16:00', work_end_time: '01:00',
    levelInfo: { eligible: true, level: 1, nextLevelDate: '2026-12-01' } },
  { id: 2, name: 'Second Employee', role: 'staff', part: 'hall', levelInfo: null },
];
const rows = [
  { day: 1, status: 'done' }, { day: 2, status: 'done', late_minutes: 5 },
  { day: 3, status: 'early_leave' }, { day: 4, status: 'working', check_out_at: null },
  { day: 5, status: 'leave', approval_status: 'pending' }, { day: 6, status: 'leave', approval_status: 'approved' },
  { day: 7, status: 'unauthorized_absence' }, { day: 9, status: 'working', check_out_at: null, late_minutes: 5 },
];
const copy = {
  ko: { title: '월간 근태', weekdays: ['일','월','화','수','목','금','토'], normal: '정상', late: '지각',
    early_leave: '조퇴', working: '근무중', pending: '승인대기', approved_leave: '휴무', unauthorized_absence: '무단결근', none: '근태 기록 없음', future: '예정일', detail: '상세보기' },
  vi: { title: 'Chấm công tháng', weekdays: ['CN','T2','T3','T4','T5','T6','T7'], normal: 'Đúng giờ', late: 'Đi muộn',
    early_leave: 'Về sớm', working: 'Đang làm', pending: 'Chờ duyệt', approved_leave: 'Nghỉ', unauthorized_absence: 'Vắng không phép', none: 'Không có dữ liệu chấm công', future: 'Ngày sắp tới', detail: 'Xem chi tiết' },
};

test('month cards reuse fetched records, show states, preserve footer and navigate dates in KO/VI at mobile/PC widths', options, async () => {
  const f = await maintenanceFixture('app/(protected)/admin/payroll/attendance/page.tsx', {
    ...attendanceStubs,
    '@/lib/auth/client-session': 'exports.attendanceFetch=(...args)=>window.qa.fetch(...args);',
    '@/components/attendance/AttendanceBonusProgressBadge': 'module.exports=()=>null;',
  });
  const artifacts = '.qa-review/attendance-month-calendar'; mkdirSync(artifacts, {recursive:true});
  try {
    for (const lang of ['ko','vi']) for (const width of [320,390,1280]) {
      const {page} = f, t = copy[lang];
      await page.setViewportSize({width,height:1000}); await page.reload();
      await page.clock.install({time:new Date('2026-11-15T05:00:00Z')});
      await page.evaluate(lang => {
        window.qa.lang=lang; window.qa.query='month=2026-11';
        window.qa.router.push=url=>(window.qa.pushed??=[]).push(url); window.mount();
      },lang);
      await page.waitForFunction(() => window.qa.requests.length===3);
      await page.evaluate(({users,rows}) => {
        for(const r of window.qa.requests) r.resolve(Response.json(r.url.includes('/users?') ? {ok:true,users} :
          r.url.includes('/records?') ? {ok:true,records:rows.map(({day,...row},i)=>({id:i+1,user_id:1,work_date:`2026-11-${String(day).padStart(2,'0')}`,
            check_in_at:'2026-11-01T09:00:00Z',check_out_at:'2026-11-01T18:00:00Z',...row}))} : {ok:true}));
      },{users,rows});
      const first=page.getByRole('button').filter({hasText:'Calendar Employee'});
      await first.click();
      const calendar=page.getByRole('group',{name:`Calendar Employee 2026-11 ${t.title}`,exact:true});
      await calendar.waitFor(); assert.equal(await calendar.locator('button[data-date]').count(),30);
      assert.equal(await calendar.locator(':scope > *').count(),35);
      const weekdays=await calendar.evaluate(el=>Array.from(el.previousElementSibling.children).map(e=>e.textContent));
      assert.deepEqual(weekdays,t.weekdays);
      const expected=['normal','late','early_leave','working','pending','approved_leave','unauthorized_absence','none'];
      for(let i=0;i<expected.length;i++) {
        const status=expected[i], day=calendar.locator(`[data-date="2026-11-${String(i+1).padStart(2,'0')}"]`);
        assert.equal(await day.getAttribute('data-status'),status);
        assert.ok((await day.getAttribute('aria-label')).includes(t[status]),status);
      }
      assert.equal(await calendar.locator('[data-date="2026-11-16"]').getAttribute('data-status'),'future');
      assert.ok((await calendar.locator('[data-date="2026-11-09"]').getAttribute('aria-label')).includes(t.working));
      // Existing status fills and distinct neutral/in-progress shapes remain visible.
      for(const [day,color] of [[1,'rgb(16, 185, 129)'],[2,'rgb(245, 158, 11)'],[3,'rgb(239, 68, 68)'],[6,'rgb(107, 114, 128)'],[7,'rgb(124, 58, 237)']]) {
        assert.equal(await calendar.locator(`[data-date="2026-11-0${day}"] > span`).last().evaluate(el=>getComputedStyle(el).backgroundColor),color);
      }
      assert.equal(await calendar.locator('[data-status="pending"] > span').last().evaluate(el=>getComputedStyle(el).borderTopStyle),'dashed');
      assert.equal(await page.getByText('16:00~01:00',{exact:true}).count(),1);
      assert.equal(await page.getByText(/2026\.12\.01/).count(),1);
      assert.equal(await page.getByRole('button',{name:t.detail,exact:true}).count(),1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      const bounds=await calendar.boundingBox(); assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width);
      await page.screenshot({path:`${artifacts}/${lang}-${width}.png`,fullPage:true});
      await calendar.locator('[data-date="2026-11-30"]').click();
      assert.equal(await page.evaluate(()=>window.qa.pushed.at(-1)),'/admin/payroll/attendance/1?month=2026-11&date=2026-11-30');
      await page.getByRole('button').filter({hasText:'Second Employee'}).click();
      assert.equal(await page.getByRole('group').count(),1);
      assert.equal(await first.getAttribute('aria-expanded'),'false');
      assert.equal(await page.evaluate(()=>window.qa.requests.length),3);
    }
    // Six-week August uses the same existing month fetch, with no requests on expansion.
    const {page}=f;
    await page.getByRole('button',{name:'‹',exact:true}).click();
    await page.waitForFunction(()=>window.qa.requests.length===5);
    await page.getByRole('button',{name:'‹',exact:true}).click();
    await page.waitForFunction(()=>window.qa.requests.length===7);
    await page.getByRole('button',{name:'‹',exact:true}).click();
    await page.waitForFunction(()=>window.qa.requests.length===9);
    await page.evaluate(users=>{for(const r of window.qa.requests.slice(7))r.resolve(Response.json({ok:true,users,records:[]}));},users);
    await page.getByRole('button').filter({hasText:'Calendar Employee'}).click();
    const august=page.getByRole('group');
    assert.equal(await august.locator(':scope > *').count(),42);
    assert.equal(await august.locator('button').count(),31);
    assert.equal(await page.evaluate(()=>window.qa.requests.length),9);
  } finally { await f.close(); }
});
