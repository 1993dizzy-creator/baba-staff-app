import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const page = read("app/(protected)/admin/sales/receipts/page.tsx");
const route = read("app/api/admin/sales/inventory-deductions/unified-preview/route.ts");
const builder = read("lib/sales/inventory-deduction-unified-preview.ts");

test("unified builder preserves fallback raw preview and accepts one shared server result", () => {
  assert.match(builder, /options\?: \{[\s\S]*?rawPreview\?: InventoryDeductionPreview \| Promise<InventoryDeductionPreview>/);
  assert.match(builder, /options\?\.rawPreview[\s\S]*?Promise\.resolve\(options\.rawPreview\)[\s\S]*?: fetchedReceiptIds\.length > 0[\s\S]*?buildInventoryDeductionPreview/);
  assert.equal((builder.match(/buildInventoryDeductionPreview\(\{/g) ?? []).length, 1);
  assert.match(builder, /preview\.receipts\.map/);
});

test("opt-in unified API shares exactly one raw preview promise and returns only receipts", () => {
  assert.match(route, /body\.includeRawReceiptPreview === true/);
  assert.equal((route.match(/buildInventoryDeductionPreview\(\{/g) ?? []).length, 1);
  assert.match(route, /void rawPreviewPromise\.catch\(\(\) => undefined\)/);
  assert.match(route, /\{ rawPreview: rawPreviewPromise \}/);
  assert.match(route, /rawPreviewReceipts: \(await rawPreviewPromise\)\.receipts/);
  assert.match(route, /rawPreviewPromise\.then\(\(preview\) => preview\.receipts\)\.catch\(\(\) => null\)/);
  assert.doesNotMatch(route, /validationSummary|inventoryTotals|kegTrackingSummary/);
});

test("invalid date range fails before the opt-in raw preview starts", () => {
  const rangeCheck = route.indexOf("if (dateFrom > dateTo)");
  const rawPreviewStart = route.indexOf("rawPreviewPromise = buildInventoryDeductionPreview");
  assert.ok(rangeCheck > -1 && rawPreviewStart > -1 && rangeCheck < rawPreviewStart);
  assert.match(route, /throw new Error\("businessDateFrom cannot be later than businessDateTo\."\)/);
  assert.match(route, /catch \(error\)[\s\S]*?status: 500/);
});

test("receipt auto preview uses one unified request while preserving abort and refresh lifecycle", () => {
  const effect = page.slice(
    page.indexOf("async function fetchReceiptDeductionPreview()"),
    page.indexOf("async function handleToggleReceipt"),
  );
  assert.doesNotMatch(effect, /inventory-deductions\/preview/);
  assert.equal((effect.match(/inventory-deductions\/unified-preview/g) ?? []).length, 1);
  assert.match(effect, /receiptIds,/);
  assert.match(effect, /includeRawReceiptPreview: true/);
  assert.match(effect, /signal: controller\.signal/);
  assert.match(effect, /cache: "no-store"/);
  assert.match(effect, /setReceiptDeductionPreview\(result\?\.rawPreviewReceipts \?\? null\)/);
  assert.match(effect, /setReceiptUnifiedPreview/);
  assert.match(effect, /receiptDeductionPreviewRefreshToken/);
});

test("manual unified preview and lazy receipt detail remain separate", () => {
  const manual = page.slice(page.indexOf("async function handleInventoryPreview()"));
  assert.match(manual, /body: JSON\.stringify\(\{\s*businessDate,\s*\}\)/);
  assert.doesNotMatch(manual.slice(0, manual.indexOf("async function handleUnifiedExecute")), /includeRawReceiptPreview/);
  assert.match(page, /async function handleToggleReceipt\(receiptId: number\)[\s\S]*?`\/api\/admin\/sales\/receipts\/\$\{receiptId\}`/);
});
