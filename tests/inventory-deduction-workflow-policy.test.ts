import assert from "node:assert/strict";
import test from "node:test";
import { classifyInventoryDeductionWorkflow } from "../lib/sales/inventory-deduction-workflow-policy";

const base = {
  isPaid: true,
  isCanceled: false,
  hasProcessingHistory: false,
  hasActiveDeduction: false,
  hasSuccessfulCurrentFingerprint: false,
  needsReprocess: false,
  actionableLineCount: 1,
  blockingReasons: [] as string[],
};

test("a paid receipt without history is an initial apply candidate regardless of source", () => {
  assert.equal(
    classifyInventoryDeductionWorkflow(base).operationType,
    "initial_apply"
  );
});

test("an edited receipt with no prior deduction applies its latest plan once", () => {
  const result = classifyInventoryDeductionWorkflow(base);
  assert.deepEqual(
    { operationType: result.operationType, canExecute: result.canExecute },
    { operationType: "initial_apply", canExecute: true }
  );
});

test("a changed applied receipt is rolled back and reapplied", () => {
  const result = classifyInventoryDeductionWorkflow({
    ...base,
    hasProcessingHistory: true,
    hasActiveDeduction: true,
    needsReprocess: true,
  });
  assert.equal(result.operationType, "reprocess_modified");
  assert.equal(result.canExecute, true);
});

test("a not-ready edited plan preserves the active deduction", () => {
  const result = classifyInventoryDeductionWorkflow({
    ...base,
    hasProcessingHistory: true,
    hasActiveDeduction: true,
    needsReprocess: true,
    blockingReasons: ["incomplete_recipe"],
  });
  assert.equal(result.operationType, "needs_check");
  assert.equal(result.canExecute, false);
});

test("mapping completion changes a preserved reprocess into an executable reprocess", () => {
  const pending = classifyInventoryDeductionWorkflow({
    ...base,
    hasProcessingHistory: true,
    hasActiveDeduction: true,
    needsReprocess: true,
    blockingReasons: ["missing_mapping"],
  });
  const ready = classifyInventoryDeductionWorkflow({
    ...base,
    hasProcessingHistory: true,
    hasActiveDeduction: true,
    needsReprocess: true,
  });
  assert.equal(pending.canExecute, false);
  assert.equal(ready.operationType, "reprocess_modified");
  assert.equal(ready.canExecute, true);
});

test("the same successfully fingerprinted receipt is a no-op", () => {
  const result = classifyInventoryDeductionWorkflow({
    ...base,
    hasProcessingHistory: true,
    hasActiveDeduction: true,
    hasSuccessfulCurrentFingerprint: true,
  });
  assert.equal(result.operationType, "no_op");
  assert.equal(result.canExecute, false);
});

test("a legacy active deduction with no explicit inventory change is a no-op", () => {
  const result = classifyInventoryDeductionWorkflow({
    ...base,
    hasProcessingHistory: true,
    hasActiveDeduction: true,
    hasSuccessfulCurrentFingerprint: false,
    needsReprocess: false,
  });
  assert.equal(result.operationType, "no_op");
});

test("a legacy active deduction with an explicit inventory-line change reprocesses", () => {
  const result = classifyInventoryDeductionWorkflow({
    ...base,
    hasProcessingHistory: true,
    hasActiveDeduction: true,
    needsReprocess: true,
  });
  assert.equal(result.operationType, "reprocess_modified");
});

test("a canceled applied receipt performs rollback only", () => {
  const result = classifyInventoryDeductionWorkflow({
    ...base,
    isCanceled: true,
    hasProcessingHistory: true,
    hasActiveDeduction: true,
  });
  assert.equal(result.operationType, "rollback_canceled");
  assert.equal(result.canExecute, true);
});

test("an already rolled-back canceled fingerprint is a no-op", () => {
  const result = classifyInventoryDeductionWorkflow({
    ...base,
    isCanceled: true,
    hasProcessingHistory: true,
    hasActiveDeduction: false,
    hasSuccessfulCurrentFingerprint: true,
  });
  assert.equal(result.operationType, "no_op");
});
