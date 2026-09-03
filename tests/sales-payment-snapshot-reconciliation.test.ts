import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Node strips TypeScript extensions in tests.
import { getPaymentSnapshotFromInvoicePayload } from "../lib/pos/cukcuk/payment-snapshot.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const sync = read("lib/pos/cukcuk/sales-receipt-sync.ts");
const dailySync = read("app/api/pos/cukcuk/sainvoices/sync-to-sales/route.ts");
const refresh = read("app/api/admin/sales/receipts/[id]/refresh-pos/route.ts");
const migration = read("supabase/migrations/202609030001_reconcile_sales_receipt_payments.sql");

test("payment sync removes rows absent from the latest authoritative snapshot", () => {
  assert.match(sync, /reconcile_sales_receipt_payments_v1/);
  assert.doesNotMatch(sync, /\.from\("pos_sales_receipt_payments"\)[\s\S]*?\.(insert|update|delete)\(/);
});

test("an authoritative empty payment snapshot can clear stale rows", () => {
  assert.deepEqual(getPaymentSnapshotFromInvoicePayload({ SAInvoicePayments: [] }), {
    available: true,
    field: "SAInvoicePayments",
    payments: [],
  });
  assert.match(dailySync, /authoritativePaymentDetails\.map\(\(item\) => item\.refId\)/);
  assert.match(refresh, /savePayments\(paymentRows, \[receiptForSave\.ref_id\]\)/);
  assert.match(migration, /jsonb_array_length\(v_snapshot->'payments'\) = 0/);
  assert.match(migration, /paid_payment_snapshot_empty/);
});

test("a missing or null payment field is unavailable and cannot clear rows", () => {
  assert.deepEqual(getPaymentSnapshotFromInvoicePayload({}), {
    available: false,
    field: null,
    payments: [],
  });
  assert.deepEqual(getPaymentSnapshotFromInvoicePayload({ SAInvoicePayments: null }), {
    available: false,
    field: "SAInvoicePayments",
    payments: [],
  });
  assert.match(dailySync, /SALES_SYNC_PAYMENT_SNAPSHOT_UNAVAILABLE/);
  assert.match(refresh, /payment_snapshot_unavailable/);
});

test("detail failure or a placeholder refId never reaches payment reconciliation", () => {
  assert.match(dailySync, /getInvoiceRefId\(detailPayload\) !== refId/);
  assert.match(dailySync, /detailPayload: null,[\s\S]*?error: "Invoice detail refId mismatch"/);
  assert.match(dailySync, /authoritativePaymentDetails = validDetails\.filter/);
});

test("manual receipt edits remain protected under the receipt row lock", () => {
  assert.match(migration, /from public\.pos_sales_receipts receipt[\s\S]*?for update/);
  assert.match(migration, /if v_receipt\.is_modified is true then[\s\S]*?continue/);
});

test("transfer-to-cash replacement and composite-distinct split happen inside one transaction RPC", () => {
  assert.match(migration, /delete from public\.pos_sales_receipt_payments/);
  assert.match(migration, /insert into public\.pos_sales_receipt_payments/);
  assert.match(migration, /jsonb_array_elements\(v_snapshot->'payments'\)/);
  assert.match(migration, /payment\.payment_type is not distinct from/);
  assert.match(migration, /payment\.payment_name is not distinct from/);
  assert.match(migration, /payment\.card_name is not distinct from/);
  assert.doesNotMatch(sync, /\.from\("pos_sales_receipt_payments"\)[\s\S]*?\.(insert|update|delete)\(/);
});

test("CUKCUK payment ID is preferred over the legacy method composite identity", () => {
  assert.match(sync, /SAInvoicePaymentID/);
  assert.match(migration, /raw_json->>'SAInvoicePaymentID'/);
});

test("RPC rejects invalid amounts and duplicate external payment IDs", () => {
  assert.match(migration, /jsonb_typeof\(v_payment->'amount'\) is distinct from 'number'/);
  assert.match(migration, /\(v_payment->>'amount'\)::numeric < 0/);
  assert.match(migration, /duplicate_payment_external_id/);
  assert.match(migration, /saInvoicePaymentId/);
});

test("RPC rejects different external IDs that collide on the production composite unique key", () => {
  assert.match(migration, /duplicate_payment_composite_identity/);
  assert.match(
    migration,
    /coalesce\(nullif\(payment->>'payment_type', ''\)::integer, -1\) payment_type/
  );
  assert.match(
    migration,
    /coalesce\(nullif\(payment->>'payment_name', ''\), ''\) payment_name/
  );
  assert.match(
    migration,
    /coalesce\(nullif\(payment->>'card_name', ''\), ''\) card_name/
  );
  assert.match(migration, /group by payment_type, payment_name, card_name/);
  assert.match(migration, /having count\(\*\) > 1/);
  assert.ok(
    migration.indexOf("duplicate_payment_composite_identity") <
      migration.indexOf("insert into public.pos_sales_receipt_payments")
  );
});

test("legacy payments without external IDs retain the production composite fallback", () => {
  assert.match(migration, /v_external_id is null/);
  assert.match(migration, /payment\.payment_type is not distinct from/);
  assert.match(migration, /payment\.payment_name is not distinct from/);
  assert.match(migration, /payment\.card_name is not distinct from/);
});

test("daily sync sends only the authoritative detail snapshot without legacy dedupe", () => {
  assert.match(dailySync, /const paymentRows = detailPaymentRows/);
  assert.doesNotMatch(dailySync, /dedupePaymentRows/);
  assert.doesNotMatch(dailySync, /getReceiptPaymentSources\(/);
});

test("RPC is service-role-only and uses invoker security with a fixed search path", () => {
  assert.match(migration, /security invoker/);
  assert.match(migration, /set search_path = pg_catalog, public/);
  assert.match(migration, /revoke all on function public\.reconcile_sales_receipt_payments_v1\(jsonb\) from public/);
  assert.match(migration, /revoke all on function public\.reconcile_sales_receipt_payments_v1\(jsonb\) from anon/);
  assert.match(migration, /revoke all on function public\.reconcile_sales_receipt_payments_v1\(jsonb\) from authenticated/);
  assert.match(migration, /alter function public\.reconcile_sales_receipt_payments_v1\(jsonb\) owner to postgres/);
  assert.match(migration, /grant execute on function public\.reconcile_sales_receipt_payments_v1\(jsonb\) to postgres, service_role/);
});
