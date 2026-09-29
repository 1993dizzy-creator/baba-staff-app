import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { buildLedgerEntries, entryDisplaySubtotal } from "../lib/ledger/entries.ts";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { entryDisplayBadgeKind, entryDisplayBadgeLabel } from "../lib/ledger/entry-display-badge.ts";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { entryCategoryEmoji } from "../lib/ledger/entry-display-emoji.ts";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { computeActualCashOutflow } from "../lib/ledger/cash-outflow.ts";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { computePaidExpenseTotal } from "../lib/ledger/payables.ts";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { calculateManualAdjustmentTotals, calculatePayrollPayoutAmounts } from "../lib/payroll/adjustments.ts";
import {
  isManualExpenseCategory,
  isPayrollAdvanceManualAction,
  MANUAL_EXPENSE_CATEGORY_NAMES,
  MANUAL_EXPENSE_SPECIAL_ACTIONS,
  manualExpenseSpecialActionLabel,
  PAYROLL_ADVANCE_MANUAL_ACTION,
  payrollAdvanceDefaultMemo,
  // @ts-expect-error local Node strip-types runner requires explicit extension
} from "../lib/ledger/manual-entry-policy.ts";
// @ts-expect-error local Node strip-types runner requires explicit extension
import { groupPayrollAdvanceEmployees, ledgerPayrollAdvanceRequestId, parsePayrollAdvanceCancelInput, parsePayrollAdvanceInput, payrollAdvanceCancelErrorStatus, payrollAdvanceEmployees, payrollAdvanceErrorStatus } from "../lib/ledger/payroll-advance.ts";

const read = (path: string) => readFileSync(path, "utf8");
const page = read("app/(protected)/admin/ledger/entries/page.tsx");
const route = read("app/api/admin/ledger/payroll-advances/route.ts");
const cancelRoute = read("app/api/admin/ledger/payroll-advances/[id]/cancel/route.ts");
const payrollAdjustmentsRoute = read("app/api/admin/payroll/adjustments/route.ts");
const compensationCard = read("components/payroll/CompensationCard.tsx");
const ledgerRoute = read("app/api/admin/ledger/route.ts");
const migration = read("supabase/migrations/20260929090000_add_ledger_payroll_advance_payment.sql");
const manualSheet = page.slice(page.indexOf("function ManualEntrySheet"));

// Shape of the rows ledger_create_payroll_advance_payment_v1 writes (and of the
// existing production advances, e.g. source_key payroll-advance-payment:2026-09-02:user:4).
const advanceRow = {
  id: 2101, type: "payroll_payment", status: "confirmed", business_date: "2026-09-02", amount: 2_000_000,
  occurred_at: "2026-09-02T05:00:00+00:00", source_type: "manual", source_key: "payroll-advance-payment:2026-09-02:user:4",
  recognition_month: null, category: null, party_id: null, memo: "Quan 급여 가불",
  source_snapshot: { userId: 4, employee: "Quan", paymentKind: "advance", payrollMonth: "2026-09-01", payrollAdjustmentId: 30 },
  movements: [{ amount: -2_000_000, fund_account: { id: 1, code: "store_cash", display_name: "현금" } }],
};

test("expense category selector keeps the 18 DB categories and adds 👥 가불 as a special action", () => {
  assert.equal(MANUAL_EXPENSE_CATEGORY_NAMES.length, 18);
  assert.ok(!MANUAL_EXPENSE_CATEGORY_NAMES.some((name: string) => /가불|급여|인건비/.test(name)));
  assert.deepEqual(MANUAL_EXPENSE_SPECIAL_ACTIONS.map((action: { value: string }) => action.value), [PAYROLL_ADVANCE_MANUAL_ACTION]);
  assert.equal(manualExpenseSpecialActionLabel(MANUAL_EXPENSE_SPECIAL_ACTIONS[0], "ko"), "👥 가불");
  assert.equal(manualExpenseSpecialActionLabel(MANUAL_EXPENSE_SPECIAL_ACTIONS[0], "vi"), "👥 Ứng lương");
  // The sentinel is never a real category row.
  assert.equal(isManualExpenseCategory({ kind: "expense", name: PAYROLL_ADVANCE_MANUAL_ACTION }), false);
  assert.equal(isPayrollAdvanceManualAction("123"), false);
  assert.match(manualSheet, /MANUAL_EXPENSE_SPECIAL_ACTIONS\.map\(\(action\) => <option key=\{action\.value\} value=\{action\.value\}>/);
  assert.equal(payrollAdvanceDefaultMemo(" Quan "), "Quan 급여 가불");
});

test("selecting 👥 가불 swaps the partner field for a required employee and posts to the advance endpoint", () => {
  assert.match(manualSheet, /const payrollAdvance = type === "expense" && isPayrollAdvanceManualAction\(categoryId\);/);
  // Employee replaces the partner select (never both).
  assert.match(manualSheet, /\{payrollAdvance \? \(\s*<BarField label=\{`👤 \$\{vi \? "Nhân viên" : "직원"\}`\} required compact>[\s\S]*?data-manual-field="employee" required[\s\S]*?\) : type === "expense" \? \(\s*<BarField label=\{`🤝/);
  assert.match(manualSheet, /if \(!isPayrollAdvanceManualAction\(next\)\) return;\s*setPartnerId\(""\);/);
  assert.match(manualSheet, /if \(payrollAdvance && !employeeId\) throw/);
  assert.match(manualSheet, /if \(payrollAdvance && !fromAccountId\) throw/);
  const body = manualSheet.slice(manualSheet.indexOf("JSON.stringify(payrollAdvance ? {"), manualSheet.indexOf("} : isInvestmentAdjustment ? {"));
  assert.match(manualSheet, /fetch\(payrollAdvance \? "\/api\/admin\/ledger\/payroll-advances"/);
  assert.match(body, /requestId: advanceRequestId,/);
  assert.match(body, /userId: Number\(employeeId\)/);
  // One UUID per advance; a retry reuses it, a successful save issues a new one.
  assert.match(manualSheet, /useState\(\(\) => crypto\.randomUUID\(\)\)/);
  assert.match(manualSheet, /if \(!response\.ok\) throw new Error\(body\.code\);\s*if \(payrollAdvance\) setAdvanceRequestId\(crypto\.randomUUID\(\)\);/);
  assert.match(body, /fromAccountId: Number\(fromAccountId\)/);
  assert.doesNotMatch(body, /categoryId|partyId|businessPartnerId|recognitionMonth|type:/);
});

test("advance input contract requires employee, account, amount and time and rejects expense fields", () => {
  const valid = { requestId: "7C9E6679-7425-40DE-944B-E07FC1F90AE7", userId: 4, amount: 2_000_000, occurredAt: "2026-09-02T12:00:00+07:00", fromAccountId: 1, memo: " Quan 급여 가불 " };
  assert.deepEqual(parsePayrollAdvanceInput(valid), { ...valid, requestId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", memo: "Quan 급여 가불" });
  assert.equal(parsePayrollAdvanceInput({ ...valid, requestId: "not-a-uuid" }), null);
  for (const missing of ["requestId", "userId", "amount", "occurredAt", "fromAccountId"]) {
    const input: Record<string, unknown> = { ...valid };
    delete input[missing];
    assert.equal(parsePayrollAdvanceInput(input), null, missing);
  }
  for (const extra of [{ categoryId: 7 }, { partyId: 3 }, { businessPartnerId: 3 }, { recognitionMonth: "2026-09-01" }, { type: "expense" }])
    assert.equal(parsePayrollAdvanceInput({ ...valid, ...extra }), null, JSON.stringify(extra));
  assert.equal(parsePayrollAdvanceInput({ ...valid, amount: 0 }), null);
  assert.equal(parsePayrollAdvanceInput({ ...valid, amount: 1.5 }), null);
  assert.equal(parsePayrollAdvanceInput({ ...valid, userId: "Quan" }), null);
  assert.equal(payrollAdvanceErrorStatus("payroll_locked"), 409);
  assert.equal(payrollAdvanceErrorStatus("request_conflict"), 409);
  assert.equal(payrollAdvanceErrorStatus("month_closed"), 409);
  assert.equal(payrollAdvanceErrorStatus("forbidden"), 403);
  // The generic manual POST refuses the sentinel instead of treating it as a category id.
  assert.match(ledgerRoute, /if \(isPayrollAdvanceManualAction\(body\.categoryId\)\) return ledgerJson\(\{ ok: false, code: "PAYROLL_ADVANCE_REQUIRES_DEDICATED_ENDPOINT" \}, 400\);/);
});

test("employee list is active payroll-eligible users keyed by real user_id", () => {
  const base = { is_active: true, is_system_account: false, payroll_eligible_override: null, full_name: null, attendance_tracking_enabled: true, part: "kitchen" };
  const employees = payrollAdvanceEmployees([
    { ...base, id: 10, name: "Triem", username: "triem", role: "staff" },
    { ...base, id: 4, name: "Quan", username: "quan", role: "staff" },
    { ...base, id: 1, name: "Owner", username: "owner", role: "owner" },
    { ...base, id: 24, name: null, full_name: "Cô Thêm", username: "them", role: "staff" },
    { ...base, id: 30, name: "Left", username: "left", role: "staff", is_active: false },
    { ...base, id: 31, name: "Excluded", username: "x", role: "staff", payroll_eligible_override: false },
    { ...base, id: 32, name: "No tracking", username: "n", role: "staff", attendance_tracking_enabled: false },
    { ...base, id: 33, name: "Vuong", username: "vuong", role: "owner", payroll_eligible_override: true, part: "owner" },
  ]);
  assert.deepEqual(employees, [
    { userId: 24, name: "Cô Thêm", part: "kitchen" },
    { userId: 4, name: "Quan", part: "kitchen" },
    { userId: 10, name: "Triem", part: "kitchen" },
    { userId: 33, name: "Vuong", part: "owner" },
  ]);
  assert.match(route, /\.select\("id,name,full_name,username,is_active,role,is_system_account,payroll_eligible_override,attendance_tracking_enabled,part"\)/);
  assert.match(route, /requireLedgerActor\(\)/);
  assert.match(route, /rpc\("ledger_create_payroll_advance_payment_v1"/);
  assert.match(route, /p_request_id: input\.requestId,\s*p_user_id: input\.userId/);
  assert.match(route, /if \(result\.status === "duplicate"\) return ledgerJson\(\{ ok: true, replayed: true, result \}, 200\);/);
});

test("advance employee options group by part in order and sort names within each part", () => {
  const groups = groupPayrollAdvanceEmployees([
    { userId: 1, name: "Zed", part: "hall" },
    { userId: 2, name: "Vuong", part: "owner" },
    { userId: 3, name: "Bar", part: "bar" },
    { userId: 4, name: "Alex", part: "hall" },
    { userId: 5, name: "Kitchen", part: "kitchen" },
    { userId: 6, name: "Cleaner", part: "cleaning" },
    { userId: 7, name: "Unknown", part: null },
  ]);
  assert.deepEqual(groups.map(group => group.part), ["kitchen", "hall", "bar", "cleaning", "owner", "etc"]);
  assert.deepEqual(groups.find(group => group.part === "hall")?.employees.map(employee => employee.name), ["Alex", "Zed"]);
  assert.deepEqual(groups.find(group => group.part === "owner")?.employees.map(employee => employee.name), ["Vuong"]);
  assert.match(manualSheet, /employeeGroups\.map\(\(group\) => \(\s*<optgroup/);
  assert.match(manualSheet, /group\.employees\.map\(\(employee\) => \(\s*<option/);
  assert.match(page, /adminUsersText\[lang\]/);
});

test("migration reuses the production advance contract and never creates a generic expense", () => {
  const sql = migration.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
  assert.match(sql, /create or replace function public\.ledger_create_payroll_advance_payment_v1\(/);
  assert.match(sql, /insert into public\.payroll_monthly_adjustments\( user_id, payroll_month, kind, category, amount, business_date, reason, note, source_type, source_key, created_by \) values \( p_user_id, v_payroll_month, 'advance', 'advance', p_amount,/);
  assert.match(sql, /v_adjustment_key := 'ledger-payroll-advance:' \|\| v_request_id;/);
  assert.match(sql, /v_transaction_key := format\('payroll-advance-payment:%s:user:%s:%s', v_business_date, p_user_id, v_request_id\);/);
  assert.match(sql, /'manual', v_adjustment_key, p_actor_user_id/);
  assert.match(sql, /v_operation_id, 'payroll_payment', p_occurred_at, v_business_date, null, p_amount, null, null, 'confirmed', 'manual', v_transaction_key,/);
  assert.match(sql, /'userId', p_user_id, 'employee', v_employee_name, 'paymentKind', 'advance'/);
  assert.match(sql, /insert into public\.ledger_movements\(transaction_id, fund_account_id, amount\) values \(v_transaction\.id, p_from_account_id, -p_amount\);/);
  assert.match(sql, /'payroll_advance_payment_created', 'transaction'/);
  assert.match(sql, /ledger_month_is_closed_v1\(v_payroll_month\)/);
  assert.match(sql, /PAYROLL_ADJUSTMENT_LOCKED_FOR_PAID_EMPLOYEE/);
  assert.doesNotMatch(sql, /'expense'|expense_recognition|ledger_create_manual_transaction_v1|category_id\s*=/);
  assert.match(sql, /revoke all on function public\.ledger_create_payroll_advance_payment_v1\(text, bigint, numeric, timestamptz, bigint, text, bigint\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.ledger_create_payroll_advance_payment_v1\(text, bigint, numeric, timestamptz, bigint, text, bigint\) to service_role;/);
});

test("an advance is a cash outflow, is deducted from net payout, and never adds P&L labor cost", () => {
  const payrollCost = {
    id: 2200, type: "expense_recognition", status: "confirmed", business_date: "2026-09-30", amount: 9_000_000,
    source_type: "payroll_completed_batch", source_key: "payroll-batch:2026-09", recognition_month: "2026-09-01",
    category: { name: "급여/인건비" }, movements: [],
  };
  const rows = [advanceRow, payrollCost];
  // P&L roots are read with .in("type", ["expense", "expense_recognition"]) — mirror that filter.
  assert.match(ledgerRoute, /\.in\("type", \["expense", "expense_recognition"\]\)/);
  const roots = rows.filter(row => row.type === "expense" || row.type === "expense_recognition").map(row => ({
    id: row.id, amount: row.amount, economicEffectSign: 1, sourceType: row.source_type, correctionOfId: null,
    payableStatus: null, allocatedAmount: 0, corrections: [],
  }));
  assert.equal(computePaidExpenseTotal(roots), 9_000_000, "labor cost is recognized once, not 9,000,000 + 2,000,000");
  // Daily expense subtotal (accounting direction) also excludes the advance.
  const entries = buildLedgerEntries(rows, [], new Map(), [], "2026-09");
  const advance = entries.find((entry: { transactionId: number | null }) => entry.transactionId === 2101)!;
  assert.equal(advance.direction, "transfer");
  assert.deepEqual(entryDisplaySubtotal(advance), { income: 0, expense: 0 });
  // Real cash left the store.
  assert.equal(computeActualCashOutflow([advanceRow], new Set([1]), "2026-09"), 2_000_000);
  // Payroll: the advance adjustment is deducted from the month's net payout.
  const totals = calculateManualAdjustmentTotals([{ kind: "advance", amount: 2_000_000, sourceType: "manual" }]);
  assert.equal(totals.advanceAmount, 2_000_000);
  const payout = calculatePayrollPayoutAmounts({
    automaticPreInsuranceAmount: 9_000_000, manualIncentiveAmount: 0, manualPenaltyAmount: 0,
    employeeInsuranceDeductionAmount: 0, advanceAmount: totals.advanceAmount,
  });
  assert.equal(payout.preInsurancePayoutAmount, 9_000_000);
  assert.equal(payout.netPayoutAmount, 7_000_000);
});

test("a saved advance renders as 지출 👥 with its paying account, not 결제", () => {
  const [entry] = buildLedgerEntries([advanceRow], [], new Map(), [], "2026-09");
  assert.equal(entryDisplayBadgeKind(entry), "expense");
  assert.equal(entryDisplayBadgeLabel(entryDisplayBadgeKind(entry), "ko"), "지출");
  assert.equal(entryCategoryEmoji(entry), "👥");
  assert.equal(entry.title, "Quan 급여 가불");
  assert.equal(entry.accountName, "현금");
  assert.equal(entry.amount, 2_000_000);
  // Supplier payable payments remain the only 결제 rows.
  const [supplierPayment] = buildLedgerEntries([{ ...advanceRow, id: 2102, type: "payable_payment", source_key: null, source_snapshot: {}, party: { name: "Trung Đông" } }], [], new Map(), [], "2026-09");
  assert.equal(entryDisplayBadgeKind(supplierPayment), "payment");
  assert.equal(entryDisplayBadgeLabel("payment", "ko"), "결제");
  assert.equal(supplierPayment.direction, "transfer");
});

// --- Ledger-only advance cancellation -------------------------------------

const REQUEST_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ledgerAdvanceRow = {
  ...advanceRow, id: 2301, source_key: `payroll-advance-payment:2026-09-02:user:4:${REQUEST_ID}`,
  source_snapshot: { ...advanceRow.source_snapshot, requestId: REQUEST_ID },
};
const reversalRow = {
  id: 2302, type: "payroll_payment", status: "confirmed", business_date: "2026-09-02", amount: 2_000_000,
  occurred_at: advanceRow.occurred_at, source_type: "payroll_advance_payment_reversal",
  source_key: `ledger-payroll-advance:${REQUEST_ID}:reversal`, correction_of_id: 2301, economic_effect_sign: -1,
  recognition_month: null, category: null, party_id: null, memo: "가불 취소 역분개: 중복 입력",
  source_snapshot: { originalTransactionId: 2301, requestId: REQUEST_ID, paymentKind: "advance_cancellation" },
  movements: [{ amount: 2_000_000, fund_account: { id: 1, code: "store_cash", display_name: "현금" } }],
};

test("only ledger-created advances are flagged as cancellable; historical and other payments are not", () => {
  assert.equal(ledgerPayrollAdvanceRequestId(ledgerAdvanceRow), REQUEST_ID);
  assert.equal(ledgerPayrollAdvanceRequestId(advanceRow), null, "historical key without request id");
  assert.equal(ledgerPayrollAdvanceRequestId({ ...ledgerAdvanceRow, type: "payable_payment" }), null);
  assert.equal(ledgerPayrollAdvanceRequestId({ ...ledgerAdvanceRow, source_type: "payroll_payment_group" }), null);
  const entries = buildLedgerEntries([ledgerAdvanceRow, advanceRow, { ...advanceRow, id: 2303, source_type: "payroll_payment_group", source_key: "payroll-payment-group:1" }], [], new Map(), [], "2026-09");
  const byId = (id: number) => entries.find((entry: { transactionId: number | null }) => entry.transactionId === id)!;
  assert.deepEqual(byId(2301).ledgerPayrollAdvance, { requestId: REQUEST_ID, cancelled: false });
  assert.equal(byId(2101).ledgerPayrollAdvance, undefined);
  assert.equal(byId(2303).ledgerPayrollAdvance, undefined);
});

test("after cancel the original stays as a flagged record, the reversal is a hidden system adjustment and cash nets to zero", () => {
  const entries = buildLedgerEntries([ledgerAdvanceRow, reversalRow], [], new Map(), [], "2026-09");
  const original = entries.find((entry: { transactionId: number | null }) => entry.transactionId === 2301)!;
  const reversal = entries.find((entry: { transactionId: number | null }) => entry.transactionId === 2302)!;
  assert.deepEqual(original.ledgerPayrollAdvance, { requestId: REQUEST_ID, cancelled: true });
  assert.equal(original.isSystemAdjustment, false);
  assert.equal(entryDisplayBadgeKind(original), "expense");
  // Current system-adjustment rule (source_type contains "reversal") hides it from the daily list.
  assert.equal(reversal.isSystemAdjustment, true);
  assert.equal(reversal.ledgerPayrollAdvance, undefined);
  assert.match(page, /const regularEntries = useMemo\(\(\) => \(data\?\.entries \?\? \[\]\)\.filter\(\(entry\) => !entry\.isSystemAdjustment\)/);
  assert.deepEqual(entryDisplaySubtotal(reversal), { income: 0, expense: 0 });
  assert.equal(computeActualCashOutflow([ledgerAdvanceRow, reversalRow], new Set([1]), "2026-09"), 0);
  assert.equal(computeActualCashOutflow([ledgerAdvanceRow], new Set([1]), "2026-09"), 2_000_000);
  // Payroll drops cancelled adjustments before calculating advanceAmount.
  assert.match(read("lib/payroll/overview-server.ts"), /rows\.filter\(row=>!row\.cancelledAt\)/);
});

test("detail modal shows 가불 취소 only for an active ledger advance and calls the dedicated endpoint", () => {
  const detail = page.slice(page.indexOf("function EntryDetailSheet"), page.indexOf("function EntryFlags"));
  assert.match(detail, /const cancellableAdvance = entry\.ledgerPayrollAdvance != null && !entry\.ledgerPayrollAdvance\.cancelled && entry\.transactionId != null;/);
  assert.match(detail, /\{cancellableAdvance \? <button type="button" disabled=\{saving\|\|advanceCancelling\|\|closed\}/);
  assert.match(detail, /\{cancellableAdvance && advanceCancelReason != null \? \(/);
  assert.match(detail, /disabled=\{advanceCancelling \|\| closed \|\| !advanceCancelReason\.trim\(\)\}/);
  assert.match(detail, /fetch\(`\/api\/admin\/ledger\/payroll-advances\/\$\{entry\.transactionId\}\/cancel`,\{method:"POST"/);
  assert.match(detail, /body:JSON\.stringify\(\{reason:advanceCancelReason\.trim\(\)\}\)/);
  assert.match(page, /onAdvanceCancelled=\{async \(\) => \{\s*setSelected\(null\);\s*await load\(\);/);
  // Shared flag component marks the cancelled original in both list and detail.
  assert.equal(page.match(/<EntryFlags entry=\{entry\} lang=\{lang\} \/>/g)?.length, 2);
  assert.match(page, /advanceCancelled \? <span className=\{styles\.cancelledBadge\}>\{vi \? "Đã hủy ứng lương" : "가불 취소됨"\}<\/span>/);
});

test("cancel endpoint validates input, maps statuses and treats a repeat cancel as success", () => {
  assert.deepEqual(parsePayrollAdvanceCancelInput("2301", { reason: "  중복 입력 " }), { transactionId: 2301, reason: "중복 입력" });
  assert.equal(parsePayrollAdvanceCancelInput("2301", { reason: "  " }), null);
  assert.equal(parsePayrollAdvanceCancelInput("2301", {}), null);
  assert.equal(parsePayrollAdvanceCancelInput("abc", { reason: "x" }), null);
  assert.equal(parsePayrollAdvanceCancelInput("2301", { reason: "x", amount: 1 }), null);
  assert.equal(payrollAdvanceCancelErrorStatus("month_closed"), 409);
  assert.equal(payrollAdvanceCancelErrorStatus("payroll_locked"), 409);
  assert.equal(payrollAdvanceCancelErrorStatus("not_ledger_payroll_advance"), 400);
  assert.equal(payrollAdvanceCancelErrorStatus("forbidden"), 403);
  assert.match(cancelRoute, /requireLedgerActor\(\)/);
  assert.match(cancelRoute, /rpc\("ledger_cancel_payroll_advance_payment_v1", \{\s*p_transaction_id: input\.transactionId,\s*p_reason: input\.reason,\s*p_actor_user_id: auth\.actor\.id,/);
  assert.match(cancelRoute, /if \(result\.status === "already_cancelled"\) return ledgerJson\(\{ ok: true, alreadyCancelled: true, result \}\);/);
});

test("cancel migration is append-only, locks, and keeps the payroll screen out of cash cancellation", () => {
  const sql = migration.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
  const cancelSql = sql.slice(sql.indexOf("create or replace function public.ledger_cancel_payroll_advance_payment_v1("));
  assert.match(cancelSql, /select \* into v_original from public\.ledger_transactions where id = p_transaction_id for update;/);
  assert.match(cancelSql, /where source_type = 'manual' and source_key = v_adjustment_key for update;/);
  assert.match(cancelSql, /update public\.payroll_monthly_adjustments set cancelled_at = now\(\), cancelled_by = p_actor_user_id, cancellation_reason = v_reason where id = v_adjustment\.id;/);
  assert.match(cancelSql, /'payroll_advance_payment_reversal', v_reversal_key,/);
  assert.match(cancelSql, /v_original\.id, '가불 취소 역분개: ' \|\| v_reason, p_actor_user_id, p_actor_user_id, -1/);
  assert.match(cancelSql, /values \(v_reversal\.id, v_movement\.fund_account_id, -v_movement\.amount\);/);
  assert.match(cancelSql, /'payroll_advance_payment_cancelled', 'transaction', v_original\.id,/);
  assert.match(cancelSql, /pg_advisory_xact_lock\(hashtext\('ledger_month_close:' \|\| to_char\(v_month, 'YYYY-MM'\)\)\)/);
  // Never deletes or rewrites the original transaction or its movement.
  assert.doesNotMatch(cancelSql, /delete from|update public\.ledger_transactions|update public\.ledger_movements/i);
  // Payroll screen: still no creation and no cancellation of ledger-origin advances.
  assert.match(payrollAdjustmentsRoute, /code:"PAYROLL_ADVANCE_USE_LEDGER"\},409\);\s*const validKindCategory/);
  assert.match(payrollAdjustmentsRoute, /if\(isLedgerPayrollAdvanceSourceKey\(existing\?\.source_key\)\)return payrollJson\(\{ok:false,code:"PAYROLL_ADVANCE_USE_LEDGER"\},409\);/);
  assert.match(compensationCard, /!automaticSales && !ledgerAdvance && <button/);
});
