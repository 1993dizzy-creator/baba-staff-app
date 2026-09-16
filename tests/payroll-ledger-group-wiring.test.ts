import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const payments = read("app/api/admin/payroll/payments/route.ts");
const accounts = read("app/api/admin/payroll/fund-accounts/route.ts");
const overview = read("app/api/admin/payroll/overview/route.ts");
const type = read("lib/payroll/overview.ts");
const card = read("components/payroll/CompensationCard.tsx");
const sync = read("app/api/admin/ledger/payroll/sync/route.ts");
const source = read("lib/ledger/employee-costs.ts");

test("payment requires a positive fund account and uses v3 RPCs", () => {
  assert.match(payments, /fundAccountId=validFundAccountId\(body\?\.fundAccountId\)/);
  assert.match(payments, /typeof value==="number"&&Number\.isSafeInteger\(value\)&&value>0/);
  assert.match(payments, /if\(!fundAccountId\)return payrollJson/);
  assert.ok(payments.indexOf("if(!fundAccountId)") < payments.indexOf('supabaseServer.rpc("payroll_pay_employee_v3"'));
  assert.match(payments, /payroll_pay_employee_v3[\s\S]*p_fund_account_id:fundAccountId/);
  assert.match(payments, /payroll_cancel_employee_payment_v3/);
  assert.doesNotMatch(payments, /payroll_(pay|cancel)_employee_[a-z_]*_v2/);
});

test("payment errors explain invalid account and closed Ledger month", () => {
  for (const value of ["PAYROLL_FUND_ACCOUNT_INVALID", "PAYROLL_LEDGER_PROJECTION_FAILED", "PAYROLL_COMPANY_COST_SYNC_FAILED", "month_closed", "지급 계좌를 다시 선택해주세요.", "Vui lòng chọn lại tài khoản chi trả."]) assert.ok(payments.includes(value), value);
});

test("payroll account list excludes card clearing and prefers corporate bank", () => {
  assert.match(accounts, /requirePayrollActor\(\)/);
  assert.match(accounts, /\.eq\("is_active", true\)/);
  assert.match(accounts, /\.neq\("code", "card_clearing"\)/);
  assert.match(accounts, /\.order\("sort_order"\)[\s\S]*\.order\("id"\)/);
  assert.match(accounts, /account\.code === "baba_corporate_bank"/);
});

test("overview and modal preserve legacy paid rows without a fund account", () => {
  assert.match(overview, /payment_date,fund_account_id,fund_account:ledger_fund_accounts\(display_name\),paid_at/);
  assert.match(type, /fund_account_id:number\|null/);
  assert.match(card, /payment\.fund_account_id==null\?/);
  assert.match(card, /기존 지급 기록 · 계좌 미지정/);
  assert.match(card, /Lịch sử chi trả · chưa chỉ định tài khoản/);
});

test("modal loads selectable account and submits its ID", () => {
  assert.match(card, /fetch\("\/api\/admin\/payroll\/fund-accounts"\)/);
  assert.match(card, /<select style=\{s\.paymentInput\} value=\{fundAccountId\?\?""\}/);
  assert.match(card, /disabled=\{busy\|\|!accountsLoaded\|\|!fundAccountId/);
  assert.match(card, /paymentDate:date,fundAccountId/);
});

test("manual payroll sync repairs groups and company cost without individual candidates", () => {
  assert.match(sync, /ledger_sync_payroll_batch_company_cost_v1/);
  assert.match(sync, /ledger_project_payroll_payment_group_v1/);
  assert.match(source, /\.eq\("payment_status", "paid"\)/);
  assert.match(source, /\.not\("fund_account_id", "is", null\)/);
  assert.match(source, /groups\.set\(`\$\{group\.paymentDate\}:\$\{group\.fundAccountId\}`/);
  assert.doesNotMatch(sync, /ledger_sync_candidates_v2|payroll_employee_payment/);
  assert.doesNotMatch(source, /sourceKey:`payroll-payment:/);
});
