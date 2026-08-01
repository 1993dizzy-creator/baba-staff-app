import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("Vietnam current-month helper uses the timezone year and month with day one", () => {
  const helper = read("lib/payroll/ui-dates.ts");
  assert.match(helper, /timeZone: "Asia\/Ho_Chi_Minh"/);
  assert.match(helper, /return `\$\{value\("year"\)\}-\$\{value\("month"\)\}-01`/);
  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).format(new Date("2026-06-30T17:30:00.000Z"));
  assert.equal(`${month}-01`, "2026-07-01");
});

test("new and existing contract forms share the Vietnam month-start default", () => {
  const settings = read("app/(protected)/admin/payroll/settings/page.tsx");
  assert.doesNotMatch(settings, /effectiveFrom:\s*"2026-08-01"/);
  assert.match(
    settings,
    /effectiveFrom:\s*vietnamCurrentMonthStart\(\)/,
  );
  assert.match(
    settings,
    /function fromContract[\s\S]*effectiveFrom:\s*vietnamCurrentMonthStart\(\)/,
  );
});

test("employee insurance keeps current-month defaults without creating revisions", () => {
  const insurance = read("components/payroll/EmployeeInsuranceSettings.tsx");
  assert.match(insurance, /const \[effectiveMonth, setEffectiveMonth\] = useState\(currentMonth\)/);
  assert.match(
    insurance,
    /fetch\([\s\S]*`\/api\/admin\/payroll\/insurance\?userId=\$\{userId\}`[\s\S]*cache: "no-store"/,
  );
});
