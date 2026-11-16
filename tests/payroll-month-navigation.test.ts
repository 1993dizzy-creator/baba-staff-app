import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { getPayrollTabs } from "../lib/navigation/payroll-tabs.ts";
import { isPayrollRunPath, withPayrollMonth } from "../lib/payroll/payroll-month-param.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const hrefs = (pathname: string, month?: string | null) => getPayrollTabs(pathname, "ko", month).map(tab => tab.href);
const active = (pathname: string) => getPayrollTabs(pathname, "vi").filter(tab => tab.active).map(tab => tab.href.split("?")[0]);

test("all three payroll tabs carry the selected month; invalid or missing months fall back to each page's default", () => {
  assert.deepEqual(hrefs("/admin/payroll/attendance", "2026-10"), ["/admin/payroll/attendance?month=2026-10", "/admin/payroll?month=2026-10", "/admin/payroll/settings?month=2026-10"]);
  for (const month of ["2026-08", "2026-09", "2026-11"]) assert.equal(hrefs("/admin/payroll", month)[1], `/admin/payroll?month=${month}`);
  for (const bad of [null, undefined, "", "bad", "2026-13", "2026-1", "2026-10-01", "1999-12"]) assert.deepEqual(hrefs("/admin/payroll/settings", bad), ["/admin/payroll/attendance", "/admin/payroll", "/admin/payroll/settings"], String(bad));
  assert.equal(withPayrollMonth("/admin/payroll", " 2026-10 "), "/admin/payroll?month=2026-10");
});

test("payroll tab is active on the overview and on a run ledger; attendance detail keeps attendance active", () => {
  assert.deepEqual(active("/admin/payroll"), ["/admin/payroll"]);
  assert.deepEqual(active("/admin/payroll/4"), ["/admin/payroll"]);
  assert.deepEqual(active("/admin/payroll/4/"), ["/admin/payroll"]);
  assert.deepEqual(active("/admin/payroll/attendance/42"), ["/admin/payroll/attendance"]);
  assert.deepEqual(active("/admin/payroll/settings"), ["/admin/payroll/settings"]);
  assert.equal(isPayrollRunPath("/admin/payroll/settings"), false);
  assert.equal(isPayrollRunPath("/admin/payroll/abc"), false);
});

test("sub nav reads ?month from the URL; attendance and run ledger keep the URL month in sync", () => {
  const nav = read("components/PayrollSubNav.tsx");
  assert.match(nav, /const month = parsePayrollMonthParam\(searchParams\.get\("month"\)\);/);
  assert.match(nav, /getPayrollTabs\(pathname, lang, month\)/);
  const attendance = read("app/(protected)/admin/payroll/attendance/page.tsx");
  // 달 이동 → URL 동기화, URL 변경(뒤로가기·앞으로가기·탭 이동) → 화면 월 동기화
  assert.match(attendance, /query\.set\("month", nextKey\);\s*router\.replace\(`\/admin\/payroll\/attendance\?\$\{query\.toString\(\)\}`, \{ scroll: false \}\);/);
  assert.match(attendance, /if \(urlMonthKey !== syncedUrlMonthKey\) \{[\s\S]*?if \(urlMonthKey && urlMonthKey !== selectedMonthKey\) \{[\s\S]*?setCurrentMonth\(new Date\(urlYear, urlMonth - 1, 1\)\);/);
  const run = read("app/(protected)/admin/payroll/[runId]/page.tsx");
  // 지급장부: 배치의 실제 급여월이 URL 월보다 우선(직접 진입·다른 월·잘못된 월 모두 장부 월로 교체)
  assert.match(run, /const ledgerMonth=ledger\?\.run\.payroll_month\.slice\(0,7\)\?\?null;/);
  assert.match(run, /if\(!ledgerMonth\|\|urlMonth===ledgerMonth\)return;[\s\S]*?query\.set\("month",ledgerMonth\);router\.replace\(`\$\{pathname\}\?\$\{query\.toString\(\)\}`,\{scroll:false\}\)/);
  // 중복 ← 급여관리 버튼 제거(상단 급여관리 탭으로 복귀)
  assert.doesNotMatch(run, /<Link|payrollOverviewHref|styles\.back/);
  // 급여설정은 정책 페이지: 월을 읽어 계산하지 않는다(탭 링크로만 이어받음)
  assert.doesNotMatch(read("app/(protected)/admin/payroll/settings/page.tsx"), /searchParams\.get\("month"\)/);
});
