import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { buildLedgerEntries, entryDisplaySubtotal } = createRequire(import.meta.url)("../lib/ledger/entries.ts") as typeof import("../lib/ledger/entries");
const page = readFileSync("app/(protected)/admin/ledger/entries/page.tsx", "utf8");
const css = readFileSync("app/(protected)/admin/ledger/entries/entries.module.css", "utf8");

function transaction(id: number, overrides: Record<string, unknown>) {
  return {
    id, type: "expense", business_date: "2026-08-31", amount: 1_000,
    economic_effect_sign: 1, source_type: "legacy_sheet_detail", memo: "실제 거래",
    ...overrides,
  };
}

test("system corrections, balance adjustments and reversals are separated from real transactions", () => {
  const entries = buildLedgerEntries([
    transaction(1, { source_type: "ledger_correction", memo: "정정" }),
    transaction(2, { type: "balance_adjustment", source_type: "manual", memo: "월말잔액 맞춤" }),
    transaction(3, { source_type: "payroll_group_reversal", memo: "상쇄" }),
    transaction(4, { memo: "상세 전환 상쇄" }),
    transaction(5, { memo: "실제 거래" }),
  ], [], new Map());
  const byId = new Map(entries.map((entry) => [entry.transactionId, entry]));
  for (const id of [1, 2, 3, 4]) assert.equal(byId.get(id)?.isSystemAdjustment, true, `transaction ${id}`);
  assert.equal(byId.get(5)?.isSystemAdjustment, false);
  assert.equal(byId.get(4)?.memo, "상세 전환 상쇄");
});

test("August small-difference correction remains in the regular ledger and its subtotal", () => {
  const entries = buildLedgerEntries([
    transaction(10, { source_type: "ledger_correction", source_key: "legacy-sheet-small-diff:2026-08", amount: 329_632, memo: "8월 시트 소액·단가차이 일괄 정정" }),
    transaction(11, { source_type: "ledger_correction", amount: 500, memo: "시스템 정정" }),
    transaction(12, { amount: 1_000 }),
  ], [], new Map());
  const regular = entries.filter((entry) => !entry.isSystemAdjustment);
  const hidden = entries.filter((entry) => entry.isSystemAdjustment);
  assert.deepEqual(regular.map((entry) => entry.transactionId).sort(), [10, 12]);
  assert.deepEqual(hidden.map((entry) => entry.transactionId), [11]);
  assert.equal(regular.reduce((sum, entry) => sum + entryDisplaySubtotal(entry).expense, 0), 330_632);
});

test("page groups regular entries only and renders no system-adjustment section", () => {
  assert.match(page, /regularEntries = useMemo\(\(\) => \(data\?\.entries \?\? \[\]\)\.filter\(\(entry\) => !entry\.isSystemAdjustment\)/);
  assert.match(page, /for \(const entry of regularEntries\) \{/);
  assert.match(page, /group\.rows\.push\(entry\);[\s\S]*entryDisplaySubtotal\(entry\)/);
  assert.match(page, /new Set\(regularEntries\.map\(\(entry\) => entry\.businessDate\)\)/);
  assert.doesNotMatch(page, /마감 조정내역|ledger-system-adjustments|systemAdjustments/);
  assert.doesNotMatch(css, /\.systemAdjustments|\.systemAdjustmentList|\.systemAdjustmentRow/);
  assert.match(page, /onClick=\{\(\) => void openEntry\(entry\)\}/);
});
