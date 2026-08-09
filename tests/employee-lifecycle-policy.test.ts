import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { employmentIntersectsMonth, isEmployedOn, shouldIncludeMonthlyEmployee, validateEmploymentDates } from "../lib/employment/eligibility.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { resolvePayrollPaymentDate } from "../lib/payroll/payment-schedule.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { enforceTerminationAccountPolicy, getVietnamDateKey } from "../lib/employment/termination-policy.ts";
// @ts-expect-error Node test execution needs explicit TypeScript extensions.
import { isPayrollEligible, isPayrollUserCandidate } from "../lib/payroll/eligibility.ts";

test("payroll eligibility uses role defaults, explicit overrides, and absolute system exclusion",()=>{
  const user=(role:string,override:boolean|null=null,isSystem=false)=>({
    role,is_system_account:isSystem,payroll_eligible_override:override
  });
  for(const role of ["staff","leader","manager"])assert.equal(isPayrollEligible(user(role)),true);
  for(const role of ["owner","master"])assert.equal(isPayrollEligible(user(role)),false);
  for(const role of ["owner","master"])assert.equal(isPayrollEligible(user(role,true)),true);
  assert.equal(isPayrollEligible(user("staff",false)),false);
  assert.equal(isPayrollEligible(user("owner",true,true)),false);
});

test("owner override still needs an existing payroll candidate condition",()=>{
  const owner={role:"owner",is_system_account:false,payroll_eligible_override:true};
  assert.equal(isPayrollUserCandidate({user:owner,employmentIntersects:false,hasAttendance:false,hasContract:false}),false);
  assert.equal(isPayrollUserCandidate({user:owner,employmentIntersects:false,hasAttendance:false,hasContract:true}),true);
  assert.equal(isPayrollUserCandidate({user:owner,employmentIntersects:true,hasAttendance:false,hasContract:false}),true);
});

test("termination saves force account deactivation and reject future Vietnam dates",()=>{
  const current={termination_date:null,is_active:true};
  for(const termination_date of ["2026-07-28","2026-07-10"]){
    const result=enforceTerminationAccountPolicy({
      update:{termination_date,is_active:true},current,today:"2026-07-28"
    });
    assert.equal(result.ok,true);
    if(result.ok)assert.equal(result.update.is_active,false);
  }
  assert.deepEqual(
    enforceTerminationAccountPolicy({
      update:{termination_date:"2026-07-29"},current,today:"2026-07-28"
    }),
    {ok:false,reason:"future_termination_date"}
  );
});

test("ordinary termination clearing does not reactivate an account",()=>{
  const result=enforceTerminationAccountPolicy({
    update:{termination_date:null,is_active:true},
    current:{termination_date:"2026-07-10",is_active:false},
    today:"2026-07-28"
  });
  assert.equal(result.ok,true);
  if(result.ok)assert.equal(result.update.is_active,false);
});

test("validated termination cancellation honors an explicitly requested reactivation",()=>{
  const result=enforceTerminationAccountPolicy({
    update:{termination_date:null,is_active:true,attendance_tracking_enabled:true,app_login_enabled:true},
    current:{termination_date:"2026-07-10",is_active:false},
    today:"2026-07-28",
    allowExplicitReactivationOnClear:true,
  });
  assert.equal(result.ok,true);
  if(result.ok)assert.deepEqual(result.update,{
    termination_date:null,
    is_active:true,
    attendance_tracking_enabled:true,
    app_login_enabled:true,
  });
});

test("termination cancellation without an explicit active value preserves the inactive state",()=>{
  const result=enforceTerminationAccountPolicy({
    update:{termination_date:null},
    current:{termination_date:"2026-07-10",is_active:false},
    today:"2026-07-28",
    allowExplicitReactivationOnClear:true,
  });
  assert.equal(result.ok,true);
  if(result.ok)assert.equal(result.update.is_active,false);
});

test("a terminated account cannot be activated while its termination date remains",()=>{
  const result=enforceTerminationAccountPolicy({
    update:{is_active:true},
    current:{termination_date:"2026-07-10",is_active:false},
    today:"2026-07-28",
    allowExplicitReactivationOnClear:true,
  });
  assert.equal(result.ok,true);
  if(result.ok)assert.equal(result.update.is_active,false);
});

test("Vietnam business date is used at the UTC day boundary",()=>{
  assert.equal(getVietnamDateKey(new Date("2026-07-28T16:59:59Z")),"2026-07-28");
  assert.equal(getVietnamDateKey(new Date("2026-07-28T17:00:00Z")),"2026-07-29");
});

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
  const nullHire={hire_date:null,termination_date:"2026-07-10",is_system_account:false,attendance_tracking_enabled:true};
  assert.equal(shouldIncludeMonthlyEmployee(nullHire,"2026-07",false),false);
  assert.equal(shouldIncludeMonthlyEmployee(nullHire,"2026-07",true),true);
  assert.equal(shouldIncludeMonthlyEmployee({hire_date:"2026-06-09",termination_date:"2026-07-10",is_system_account:false,attendance_tracking_enabled:true},"2026-07",false),true);
  assert.equal(shouldIncludeMonthlyEmployee({hire_date:"2026-06-09",termination_date:"2026-07-10",is_system_account:false,attendance_tracking_enabled:true},"2026-07",true),true);
  assert.equal(shouldIncludeMonthlyEmployee({hire_date:null,termination_date:null,is_system_account:true,attendance_tracking_enabled:true},"2026-07",true),false);
});

test("attendance_tracking_enabled=false only shows in a month with an actual record, matching the current-list rule",()=>{
  const trackingOff={hire_date:"2026-06-09",termination_date:null,is_system_account:false,attendance_tracking_enabled:false};
  assert.equal(shouldIncludeMonthlyEmployee(trackingOff,"2026-07",false),false);
  assert.equal(shouldIncludeMonthlyEmployee(trackingOff,"2026-07",true),true);
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

test("payroll override migration is nullable and does not backfill users",()=>{
  const migration=read("supabase/migrations/202607280002_add_payroll_eligibility_override.sql");
  assert.match(migration,/payroll_eligible_override boolean null/);
  assert.doesNotMatch(migration,/update\s+public\.users/i);
});

test("employee UI separates account access, termination and explicit rehire confirmation",()=>{
  const page=read("app/(protected)/admin/users/page.tsx");
  const text=read("lib/text/admin-users.ts");
  const api=read("app/api/admin/users/route.ts");
  assert.match(page,/termination_date/);
  assert.match(page,/confirm\(text\.rehireWarning\)/);
  assert.match(api,/action === "rehire"/);
  assert.match(api,/confirmPreviousPayrollCompleted !== true/);
  assert.match(api,/enforceTerminationAccountPolicy/);
  assert.match(api,/퇴사일은 오늘 이후 날짜로 설정할 수 없습니다/);
  assert.match(api,/Ngày nghỉ việc không thể sau ngày hôm nay/);
  assert.match(page,/terminationDeactivationNotice/);
  assert.match(page,/draft\.termination_date \? false : draft\.is_active !== false/);
  assert.match(page,/setUsers\(\(current\) =>\s*current\.map/);
  assert.match(page,/if \(user\.is_active === false\) return "inactive"/);
  assert.match(text,/퇴사일을 저장하면 계정 사용도 중지됩니다/);
  assert.match(text,/Khi lưu ngày nghỉ việc, tài khoản cũng sẽ bị vô hiệu hóa/);
  assert.match(page,/!isOwnerGroupUser\(user\)/);
  assert.match(page,/user\.termination_date === null/);
  assert.match(page,/activeEmployeeCount\}\{text\.peopleUnit\}/);
  assert.match(page,/text\.summaryLabel/);
  assert.match(page,/!isAdminGroupUser && !user\.termination_date/);
  assert.match(page,/payroll_eligible_override/);
  assert.match(page,/event\.target\.checked \? true : null/);
  assert.match(text,/급여 대상에 포함/);
  assert.match(text,/Bao gồm trong bảng lương/);
  assert.match(text,/Tình hình nhân viên/);
  assert.match(page,/flexWrap: "wrap"/);
  assert.match(api,/isPayrollOwnerRole\(target\.role\)/);
  for(const label of ["퇴사일","계정 사용 가능","복귀 처리","Ngày nghỉ việc","Cho phép sử dụng tài khoản","Cho làm lại"])assert.match(text,new RegExp(label));
});

test("termination cancellation is explicit, preserves hire date, and does not bypass rehire v3",()=>{
  const page=read("app/(protected)/admin/users/page.tsx");
  const api=read("app/api/admin/users/route.ts");
  const policy=read("lib/employment/termination-policy.ts");
  assert.match(page,/original\.termination_date[\s\S]*draft\.termination_date === null[\s\S]*draft\.is_active !== false[\s\S]*"cancel_termination"/);
  assert.match(api,/const isCancelTermination = body\.action === "cancel_termination"/);
  assert.match(api,/update\.termination_date === null/);
  assert.match(api,/update\.is_active === true/);
  assert.match(api,/update\.hire_date === target\.hire_date/);
  assert.match(api,/allowExplicitReactivationOnClear: isCancelTermination/);
  assert.match(policy,/hasExplicitActiveUpdate/);
  assert.match(api,/body\.action === "rehire"[\s\S]*employee_rehire_with_level_policy_v3/);
  assert.doesNotMatch(policy,/hire_date|level_program|payroll/);
  assert.match(api,/if \(target\.termination_date && levelPolicyChanged\)/);
});

test("terminated accounts remain blocked by the login active-user filter",()=>{
  const login=read("app/api/login/route.ts");
  assert.match(login,/\.eq\("is_active", true\)/);
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

test("employee payment UI records the actual payment date independently of the payroll month",()=>{
  const detail=read("app/(protected)/admin/payroll/[runId]/page.tsx");
  const payments=read("app/api/admin/payroll/payments/route.ts");
  const settings=read("components/payroll/PayrollCommonSettings.tsx");
  assert.match(detail,/payment_date/);
  assert.match(payments,/p_payment_date:paymentDate/);
  assert.match(payments,/p_month:`\$\{month\}-01`/);
  assert.match(settings,/매월 1일 ~ 말일/);
  assert.match(settings,/Tháng sau, ngày/);
});
