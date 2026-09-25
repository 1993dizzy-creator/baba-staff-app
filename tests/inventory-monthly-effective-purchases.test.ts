import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  buildMonthlyEffectivePurchases,
  type MonthlyPurchaseLog,
} from "../lib/inventory/monthly-effective-purchases.ts";

const route = readFileSync(
  join(process.cwd(), "app/api/inventory/monthly/route.ts"),
  "utf8"
);

const purchaseLog = (
  overrides: Partial<MonthlyPurchaseLog> = {}
): MonthlyPurchaseLog => ({
  id: 10946,
  item_id: 225,
  item_name: "소고기",
  item_name_vi: "Thịt bò",
  part: "kitchen",
  category: "육류",
  category_vi: "Thịt",
  change_quantity: 21415,
  unit: "Kg",
  code: "BEEF",
  new_purchase_price: 365000,
  new_supplier: "Thiên Vương",
  reason: "purchase",
  business_date: "2026-09-14",
  correction_of_inventory_log_id: null,
  ...overrides,
});

test("beef corrections and a later purchase produce 29.02kg and 10,592,300 VND", () => {
  const roots = [
    purchaseLog(),
    purchaseLog({
      id: 11610,
      business_date: "2026-09-22",
      change_quantity: 12.6,
    }),
  ];
  const corrections = [
    purchaseLog({
      id: 10947,
      change_quantity: -21398.58,
      correction_of_inventory_log_id: 10946,
    }),
  ];

  const effective = buildMonthlyEffectivePurchases(roots, corrections);
  const quantity = Math.round(effective.reduce(
    (sum, purchase) => sum + purchase.effectiveQuantity,
    0
  ) * 1000) / 1000;
  const amount = effective.reduce(
    (sum, purchase) =>
      sum + purchase.effectiveQuantity * Number(purchase.new_purchase_price),
    0
  );

  assert.equal(quantity, 29.02);
  assert.equal(amount, 10592300);
  assert.deepEqual(new Set(effective.map((purchase) => purchase.new_supplier)), new Set(["Thiên Vương"]));
});

test("a fully cancelled two-unit purchase is absent from effective purchases", () => {
  const root = purchaseLog({ id: 200, change_quantity: 2, new_purchase_price: 30000 });
  const correction = purchaseLog({
    id: 201,
    change_quantity: -2,
    new_purchase_price: 30000,
    correction_of_inventory_log_id: 200,
  });

  assert.deepEqual(buildMonthlyEffectivePurchases([root], [correction]), []);
});

test("latest correction supplies price, supplier and nullable display metadata", () => {
  const root = purchaseLog({
    id: 300,
    change_quantity: 10,
    new_purchase_price: 10000,
    new_supplier: "A",
  });
  const firstCorrection = purchaseLog({
    id: 301,
    change_quantity: 0,
    new_purchase_price: 11000,
    new_supplier: "A",
    correction_of_inventory_log_id: 300,
  });
  const latestCorrection = purchaseLog({
    id: 302,
    change_quantity: 0,
    item_name: null,
    item_name_vi: null,
    part: null,
    category: null,
    category_vi: null,
    unit: null,
    code: null,
    new_purchase_price: 12000,
    new_supplier: "B",
    correction_of_inventory_log_id: 300,
  });

  const [effective] = buildMonthlyEffectivePurchases(
    [root],
    [firstCorrection, latestCorrection]
  );
  assert.equal(effective.effectiveQuantity, 10);
  assert.equal(effective.new_purchase_price, 12000);
  assert.equal(effective.new_supplier, "B");
  assert.equal(effective.item_name, null);
  assert.equal(effective.code, null);
});

test("linked corrections never become separate purchases and normal roots remain unchanged", () => {
  const root = purchaseLog({ id: 400, change_quantity: 5, new_purchase_price: 7000 });
  const correction = purchaseLog({
    id: 401,
    change_quantity: 1,
    correction_of_inventory_log_id: 400,
  });

  const effective = buildMonthlyEffectivePurchases([root, correction], [correction]);
  assert.equal(effective.length, 1);
  assert.equal(effective[0].rootLogId, 400);
  assert.equal(effective[0].effectiveQuantity, 6);

  const [unchanged] = buildMonthlyEffectivePurchases([root], []);
  assert.equal(unchanged.effectiveQuantity, 5);
  assert.equal(unchanged.new_purchase_price, 7000);
});

test("monthly item and supplier summaries share effective purchases while other movement reasons stay raw", () => {
  assert.match(route, /const effectivePurchaseLogs = buildMonthlyEffectivePurchases/);
  assert.match(route, /for \(const purchase of effectivePurchaseLogs\)/);
  assert.match(route, /buildSupplierSummary\(\s*effectivePurchaseLogs,/);
  assert.match(route, /if \(normalizedReason === "purchase"\) continue;/);
  for (const reason of ["stock_check", "service", "sale_deduction"]) {
    assert.match(route, new RegExp(`normalizedReason === "${reason}"`));
  }
  assert.match(route, /target\.otherNetChange = roundDecimal/);
});
