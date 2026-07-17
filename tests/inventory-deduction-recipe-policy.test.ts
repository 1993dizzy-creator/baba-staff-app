import assert from "node:assert/strict";
import test from "node:test";
import { shouldBlockIncompleteRecipe } from "../lib/sales/inventory-deduction-recipe-policy";
import { classifyInventoryDeductionWorkflow } from "../lib/sales/inventory-deduction-workflow-policy";

const workflowBase = {
  isPaid: true,
  isCanceled: false,
  hasProcessingHistory: false,
  hasActiveDeduction: false,
  hasSuccessfulCurrentFingerprint: false,
  needsReprocess: false,
};

test("an incomplete recipe on an original POS line is excluded and becomes a terminal no-op", () => {
  const blocks = shouldBlockIncompleteRecipe({
    source: "cukcuk",
    isModified: false,
    isOption: false,
  });
  const workflow = classifyInventoryDeductionWorkflow({
    ...workflowBase,
    actionableLineCount: 0,
    blockingReasons: blocks ? ["incomplete_recipe"] : [],
  });

  assert.equal(blocks, false);
  assert.equal(workflow.operationType, "no_op");
  assert.equal(workflow.canExecute, false);
});

test("an original POS receipt applies ready lines while excluding an incomplete recipe line", () => {
  const blocks = shouldBlockIncompleteRecipe({
    source: "cukcuk",
    isModified: false,
    isOption: false,
  });
  const workflow = classifyInventoryDeductionWorkflow({
    ...workflowBase,
    actionableLineCount: 1,
    blockingReasons: blocks ? ["incomplete_recipe"] : [],
  });

  assert.equal(workflow.operationType, "initial_apply");
  assert.equal(workflow.canExecute, true);
});

test("an incomplete recipe on a manually-created receipt is skipped", () => {
  const blocks = shouldBlockIncompleteRecipe({
    source: "manual",
    isModified: false,
    isOption: false,
  });
  const workflow = classifyInventoryDeductionWorkflow({
    ...workflowBase,
    actionableLineCount: 0,
    blockingReasons: blocks ? ["incomplete_recipe"] : [],
  });

  assert.equal(blocks, false);
  assert.equal(workflow.operationType, "no_op");
});

test("an incomplete recipe on an edited receipt does not block its latest plan", () => {
  const blocks = shouldBlockIncompleteRecipe({
    source: "cukcuk",
    isModified: true,
    isOption: false,
  });
  const workflow = classifyInventoryDeductionWorkflow({
    ...workflowBase,
    hasProcessingHistory: true,
    hasActiveDeduction: true,
    needsReprocess: true,
    actionableLineCount: 1,
    blockingReasons: blocks ? ["incomplete_recipe"] : [],
  });

  assert.equal(blocks, false);
  assert.equal(workflow.operationType, "reprocess_modified");
  assert.equal(workflow.canExecute, true);
});

test("an incomplete recipe on a selected T-code option is skipped", () => {
  assert.equal(
    shouldBlockIncompleteRecipe({
      source: "cukcuk",
      isModified: false,
      isOption: true,
    }),
    false
  );
});
