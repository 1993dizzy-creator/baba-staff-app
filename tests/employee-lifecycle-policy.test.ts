import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { employmentIntersectsMonth, isEmployedOn, shouldIncludeMonthlyEmployee, validateEmploymentDates } from "../lib/employment/eligibility.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { resolvePayrollPaymentDate } from "../lib/payroll/payment-schedule.ts";

const read=(file:string)=>fs.readFileSync(path.join(process.cwd(),file),"utf8");

test("termination day is inclusive and later dates are excluded",()=>{
  const user={hire_date:"2026-06-09",termination_date:"2026-07-10"};
  assert.equal(isEmployedOn(user,"2026-07-10"),true);
  assert.equal(isEmployedOn(user,"2026-07-11"),false);
  assert.equal(employmentIntersectsMonth(user,"2026-07"),true);
  assert.equal(employmentIntersectsMonth(user,"2026-08"),false);
  assert.equal(validateEmploymentDates({hire_date:"2026-07-10",termination_date:"2026-07-10"}),true);
  assert.equal(validateEmploymentDates({hire_date:"2026-07-10",termination_date:"2026-07-09"}),false);
});

test("monthly attendance requires an actual record or an explicit intersecting hire date",()=>{
  const nullHire={hire_date:null,termination_date:"2026-07-10",is_system_account:false};
  assert.equal(shouldIncludeMonthlyEmployee(nullHire,"2026-07",false),false);
  assert.equal(shouldIncludeMonthlyEmployee(nullHire,"2026-07",true),true);
  assert.equal(shouldIncludeMonthlyEmployee({hire_date:"2026-06-09",termination_date:"2026-07-10",is_system_account:false},"2026-07",false),true);
  assert.equal(shouldIncludeMonthlyEmployee({hire_date:"2026-06-09",termination_date:"2026-07-10",is_system_account:false},"2026-07",true),true);
  assert.equal(shouldIncludeMonthlyEmployee({hire_date:null,termination_date:null,is_system_account:true},"2026-07",true),false);
});

test("real-time eligibility continues to allow a missing hire date",()=>{
  assert.equal(isEmployedOn({hire_date:null,termination_date:null},"2026-07-28"),true);
});

test("payroll due date rolls into the next month and year",()=>{
  assert.equal(resolvePayrollPaymentDate("2026-07"),"2026-08-10");
  assert.equal(resolvePayrollPaymentDate("2026-12"),"2027-01-10");
});

test("system accounts are filtered server-side without username or id checks",()=>{
  const adminUsers=read("app/api/admin/users/route.ts");
  const attendanceUsers=read("app/api/attendance/users/route.ts");
  const payrollUsers=read("app/api/admin/payroll/users/route.ts");
  for(const source of [adminUsers,attendanceUsers,payrollUsers])assert.match(source,/is_system_account/);
  for(const source of [adminUsers,attendanceUsers,payrollUsers]){
    assert.doesNotMatch(source,/username\s*===?\s*["']pos["']/);
    assert.doesNotMatch(source,/\.id\s*===?\s*22/);
  }
});

test("migration adds lifecycle, POS verification, payroll schedule and due-date snapshot",()=>{
  const migration=read("supabase/migrations/202607280001_add_employee_lifecycle_and_payroll_schedule.sql");
  assert.match(migration,/is_system_account boolean not null default false/);
  assert.match(migration,/termination_date date null/);
  assert.match(migration,/users_employment_dates_check/);
  assert.match(migration,/where username = 'pos'/);
  assert.match(migration,/create table public\.payroll_settings/);
  assert.match(migration,/payment_due_date date/);
  assert.match(migration,/payment_schedule_snapshot jsonb/);
  assert.doesNotMatch(migration,/limthiphuongduy2004|user_id\s*=\s*20/);
});

test("employee UI separates account access, termination and explicit rehire confirmation",()=>{
  const page=read("app/(protected)/admin/users/page.tsx");
  const text=read("lib/text/admin-users.ts");
  const api=read("app/api/admin/users/route.ts");
  assert.match(page,/termination_date/);
  assert.match(page,/confirm\(text\.rehireWarning\)/);
  assert.match(api,/action === "rehire"/);
  assert.match(api,/confirmPreviousPayrollCompleted !== true/);
  for(const label of ["퇴사일","계정 사용 가능","복귀 처리","Ngày nghỉ việc","Cho phép sử dụng tài khoản","Cho làm lại"])assert.match(text,new RegExp(label));
});

test("employee management uses the signed server cookie and no actorUsername client identity",()=>{
  const list=read("app/(protected)/admin/users/page.tsx");
  const create=read("app/(protected)/admin/users/create/page.tsx");
  const api=read("app/api/admin/users/route.ts");
  const createApi=read("app/api/admin/users/create/route.ts");
  const login=read("app/api/login/route.ts");
  const logout=read("app/api/logout/route.ts");
  assert.match(login,/setServerSessionCookie\(response, data\.id\)/);
  assert.match(logout,/clearServerSessionCookie\(response\)/);
  for(const source of [api,createApi])assert.match(source,/requireRole\(\["owner", "master"\]\)/);
  for(const source of [list,create,api,createApi])assert.doesNotMatch(source,/actorUsername/);
  for(const source of [list,create])assert.match(source,/attendanceFetch\("\/api\/admin\/users/);
});

test("migration is atomic and preserves singleton, predecessor and due-date snapshots",()=>{
  const migration=read("supabase/migrations/202607280001_add_employee_lifecycle_and_payroll_schedule.sql");
  assert.match(migration,/^begin;/);
  assert.match(migration,/commit;\s*$/);
  assert.match(migration,/id smallint primary key default 1 check \(id = 1\)/);
  assert.match(migration,/revoke all on table public\.payroll_settings from public, anon, authenticated, service_role/);
  assert.match(migration,/grant select, insert, update on table public\.payroll_settings to service_role/);
  assert.match(migration,/add column if not exists payment_due_date date null/);
  assert.match(migration,/v_effective_to:=v_first\.effective_from/);
  assert.match(migration,/v_old\.payment_due_date,v_old\.payment_schedule_snapshot/);
  assert.match(migration,/drop constraint if exists payroll_runs_payroll_month_check/);
  assert.equal((migration.match(/update public\.users set is_system_account = true/g)??[]).length,1);
});

test("payroll UI and API keep due and actual payment dates distinct",()=>{
  const list=read("app/(protected)/admin/payroll/page.tsx");
  const detail=read("app/(protected)/admin/payroll/[runId]/page.tsx");
  const settings=read("components/payroll/PayrollScheduleSettings.tsx");
  assert.match(list,/payment_due_date/);
  assert.match(detail,/payment_due_date/);
  assert.match(detail,/payment_date/);
  assert.match(settings,/매월 1일 ~ 말일/);
  assert.match(settings,/của tháng tiếp theo/);
});
