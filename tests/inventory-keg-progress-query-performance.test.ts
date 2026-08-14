import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const modulePath = "../lib/inventory/keg-progress-core.ts";
const { calculateKegSalesForSession, getKegLineReferenceTime } = await import(
  modulePath
);

const paidReceipt = (id: number, values: Record<string, unknown> = {}) => ({
  id,
  ref_date: "2026-08-14T11:00:00.000Z",
  synced_at: null,
  updated_at: null,
  payment_status: 3,
  is_canceled: false,
  ...values,
});

const regularLine = (id: number, values: Record<string, unknown> = {}) => ({
  id,
  receipt_id: 1,
  item_id: "regular-id",
  item_code: "REG",
  quantity: 1,
  is_option: false,
  is_excluded: false,
  is_canceled: false,
  payment_status: 3,
  ref_date: "2026-08-14T11:00:00.000Z",
  synced_at: null,
  updated_at: null,
  ...values,
});

test("mapped Keg lines preserve exclusions, fallback order, boundaries, and per-mapping math", () => {
  const receipts = [
    paidReceipt(1),
    paidReceipt(2, { is_canceled: true }),
    paidReceipt(3, { ref_date: null, synced_at: "2026-08-14T11:00:00.000Z" }),
    paidReceipt(4, { ref_date: null, synced_at: null, updated_at: "2026-08-14T11:00:00.000Z" }),
  ];
  const result = calculateKegSalesForSession({
    startedAt: "2026-08-14T10:00:00.000Z",
    mappings: [
      { pos_product_id: 10, quantity_per_pos_unit: 100 },
      { pos_product_id: 11, quantity_per_pos_unit: 1000 },
      { pos_product_id: 12, quantity_per_pos_unit: 50 },
    ],
    products: [
      {
        id: 10,
        pos_item_id: "regular-id",
        item_id: "regular-id",
        item_code: "REG",
        item_name: "Regular glass",
        unit_name: "Cup",
      },
      {
        id: 11,
        pos_item_id: "tower-id",
        item_id: null,
        item_code: "TOWER",
        item_name: "Beer tower",
        unit_name: "Tower",
      },
      {
        id: 12,
        pos_item_id: "other-id",
        item_id: null,
        item_code: "OTHER",
        item_name: null,
        unit_name: null,
      },
    ],
    receipts,
    lines: [
      regularLine(1, { quantity: 2 }),
      regularLine(2, { is_option: true, quantity: 10 }),
      regularLine(3, { is_excluded: true, quantity: 10 }),
      regularLine(4, { is_canceled: true, quantity: 10 }),
      regularLine(5, { payment_status: 2, quantity: 10 }),
      regularLine(6, { receipt_id: 2, quantity: 10 }),
      regularLine(7, {
        ref_date: "2026-08-14T09:00:00.000Z",
        receipt_id: 1,
      }),
      regularLine(8, { ref_date: null, receipt_id: 1 }),
      regularLine(9, {
        ref_date: null,
        receipt_id: 3,
        synced_at: "2026-08-14T11:00:00.000Z",
      }),
      regularLine(10, { ref_date: null, receipt_id: 3, synced_at: null }),
      regularLine(11, {
        ref_date: null,
        receipt_id: 4,
        synced_at: null,
        updated_at: "2026-08-14T11:00:00.000Z",
      }),
      regularLine(12, { ref_date: "2026-08-14T09:59:59.999Z" }),
      regularLine(13, { ref_date: "2026-08-14T10:00:00.000Z" }),
      regularLine(14, { ref_date: "2026-08-14T10:00:00.001Z" }),
      regularLine(15, { receipt_id: 999 }),
      regularLine(16, {
        item_id: "tower-id",
        item_code: "NO-CODE-MATCH",
        quantity: 1,
      }),
      regularLine(17, {
        item_id: "no-id-match",
        item_code: "TOWER",
        quantity: 2,
      }),
      regularLine(18, {
        item_id: "other-id",
        item_code: "OTHER",
        quantity: 3,
      }),
    ],
  });

  assert.deepEqual(result, {
    soldMl: 3950,
    salesBreakdown: {
      totalUnits: 14,
      regularUnits: 8,
      regularSoldMl: 800,
      regularAverageMl: 100,
      towerUnits: 3,
      towerSoldMl: 3000,
      towerAverageMl: 1000,
      otherUnits: 3,
      otherSoldMl: 150,
    },
  });
});

test("the first valid timestamp wins even when a later fallback crosses the session start", () => {
  const receipt = paidReceipt(1, {
    ref_date: "2026-08-14T11:00:00.000Z",
  });
  const line = regularLine(1, {
    ref_date: "2026-08-14T09:00:00.000Z",
    synced_at: "2026-08-14T12:00:00.000Z",
  });
  assert.equal(
    getKegLineReferenceTime(line, receipt),
    Date.parse("2026-08-14T09:00:00.000Z")
  );
});

test("Keg progress queries narrow both receipt and timestamp paths before transfer", () => {
  const source = readFileSync(
    join(process.cwd(), "lib/inventory/keg-progress.ts"),
    "utf8"
  );
  const lineSection = source.slice(
    source.indexOf("const lineSelect"),
    source.indexOf("const missingReceiptIds")
  );

  assert.match(lineSection, /\.in\("receipt_id", receiptIdChunk\)/);
  assert.equal((lineSection.match(/\.or\(lineMatchFilter\)/g) || []).length, 2);
  assert.match(
    lineSection,
    /\.or\(lineMatchFilter\)\s*\.or\(lineTimeFilter\)/
  );
  assert.match(lineSection, /await Promise\.all\(lineRequests\)/);
  assert.doesNotMatch(
    lineSection,
    /\.eq\("payment_status", 3\)\s*\.or\(\s*`ref_date\.gte[^]*?\.range/
  );
});
