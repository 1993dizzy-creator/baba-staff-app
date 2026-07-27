import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

test("legacy attendance overview URLs temporarily redirect to payroll attendance", () => {
  const config = read("next.config.ts");

  assert.match(config, /source: "\/attendance\/overview"[\s\S]*?destination: "\/admin\/payroll\/attendance"[\s\S]*?permanent: false/);
  assert.match(config, /source: "\/attendance\/overview\/:path\*"[\s\S]*?destination: "\/admin\/payroll\/attendance\/:path\*"[\s\S]*?permanent: false/);
});

test("payroll routes are server-protected for owner and master", () => {
  const layout = read("app/(protected)/admin/payroll/layout.tsx");

  assert.match(layout, /requireRole\(\["owner", "master"\]\)/);
  assert.match(layout, /redirect\(auth\.status === 401 \? "\/login" : "\/admin"\)/);
});

test("attendance detail back link and legacy redirects preserve query strings", () => {
  const overview = read("app/(protected)/admin/payroll/attendance/page.tsx");
  const detail = read("app/(protected)/admin/payroll/attendance/[userId]/page.tsx");

  assert.match(overview, /getMonthFromParam\(searchParams\.get\("month"\)\)/);
  assert.match(detail, /\/admin\/payroll\/attendance\?month=\$\{currentMonth\.getFullYear\(\)\}/);

  const legacyUrl = new URL("https://staff.example/attendance/overview/42?month=2026-07&date=2026-07-22");
  const destination = legacyUrl.pathname.replace(
    /^\/attendance\/overview/,
    "/admin/payroll/attendance"
  ) + legacyUrl.search;

  assert.equal(
    destination,
    "/admin/payroll/attendance/42?month=2026-07&date=2026-07-22"
  );
});

test("attendance subnav no longer links to the legacy overview", () => {
  const tabs = read("lib/navigation/attendance-tabs.ts");

  assert.doesNotMatch(tabs, /attendance\/overview|전체현황|Tổng quan/);
  assert.match(tabs, /href: "\/attendance"/);
});

test("admin cards use the approved bilingual copy and keep store settings last", () => {
  const admin = read("app/(protected)/admin/page.tsx");

  assert.match(admin, /근태 현황과 급여를 관리하고 급여 기준을 설정합니다\./);
  assert.match(admin, /Quản lý chấm công, tiền lương và thiết lập tiêu chuẩn tính lương\./);
  assert.match(admin, /매장 영업시간과 근태 기준을 설정합니다\./);
  assert.match(admin, /Thiết lập giờ hoạt động của cửa hàng và tiêu chuẩn chấm công\./);
  assert.ok(admin.lastIndexOf('href: "/admin/settings/store"') > admin.lastIndexOf('href: "/admin/pos/mappings"'));
});

test("payroll tabs keep the approved order, translations, and one-line styling", () => {
  const tabs = read("lib/navigation/payroll-tabs.ts");
  const subnav = read("components/SubNav.tsx");

  const attendanceIndex = tabs.indexOf('href: "/admin/payroll/attendance"');
  const managementIndex = tabs.indexOf('href: "/admin/payroll"', attendanceIndex + 1);
  const settingsIndex = tabs.indexOf('href: "/admin/payroll/settings"');
  assert.ok(attendanceIndex < managementIndex && managementIndex < settingsIndex);
  assert.match(tabs, /"Chấm công" : "근태현황"/);
  assert.match(tabs, /"Tiền lương" : "급여관리"/);
  assert.match(tabs, /"Cài đặt lương" : "급여설정"/);
  assert.match(subnav, /whiteSpace: "nowrap"/);
});
