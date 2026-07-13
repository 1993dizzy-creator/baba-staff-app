export type InventoryDeductionWorkflowOperation =
  | "initial_apply"
  | "reprocess_modified"
  | "rollback_canceled"
  | "needs_check"
  | "no_op";

export function classifyInventoryDeductionWorkflow(input: {
  isPaid: boolean;
  isCanceled: boolean;
  hasProcessingHistory: boolean;
  hasActiveDeduction: boolean;
  hasSuccessfulCurrentFingerprint: boolean;
  needsReprocess: boolean;
  actionableLineCount: number;
  blockingReasons: string[];
}) {
  const blockingReasons = [...input.blockingReasons];

  if (input.hasProcessingHistory && input.isCanceled) {
    if (input.hasSuccessfulCurrentFingerprint) {
      return { operationType: "no_op" as const, canExecute: false, blockingReasons };
    }
    if (input.hasActiveDeduction) {
      return {
        operationType: "rollback_canceled" as const,
        canExecute: true,
        blockingReasons: [],
      };
    }
    return {
      operationType: "needs_check" as const,
      canExecute: false,
      blockingReasons: [...blockingReasons, "canceled_without_active_deduction"],
    };
  }

  if (input.needsReprocess) {
    if (blockingReasons.length > 0) {
      return { operationType: "needs_check" as const, canExecute: false, blockingReasons };
    }
    return {
      operationType: "reprocess_modified" as const,
      canExecute: true,
      blockingReasons,
    };
  }

  if (
    input.isPaid &&
    !input.isCanceled &&
    !input.hasProcessingHistory
  ) {
    if (blockingReasons.length > 0) {
      return { operationType: "needs_check" as const, canExecute: false, blockingReasons };
    }
    if (input.actionableLineCount > 0) {
      return { operationType: "initial_apply" as const, canExecute: true, blockingReasons };
    }
  }

  return { operationType: "no_op" as const, canExecute: false, blockingReasons };
}
