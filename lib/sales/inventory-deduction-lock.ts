// Preserve PostgreSQL contention through candidate-save boundaries. A retry
// must rebuild preview/validation; never replay a stored stock plan blindly.
export function isInventoryDeductionBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "55P03";
}

export function inventoryDeductionWriteError(error: { message: string; code?: string }) {
  return Object.assign(new Error(error.message), { code: error.code });
}

export const inventoryBusyResponse = {
  ok: false, result: "stale_preview", code: "55P03",
  retryable: true, requiresRefresh: true,
  error: "Inventory is busy. Refresh the preview and retry.",
} as const;
