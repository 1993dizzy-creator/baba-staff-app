export type SalesSyncCompletenessEvidence = {
  status: 'success' | 'failed';
  limitReached: boolean;
  skippedDetailCount: number;
  paymentSnapshotUnavailableCount: number;
  receiptPaymentSourceComplete: boolean;
  partial: boolean;
  errorMessage?: string | null;
};

/** Unknown evidence is never sufficient to authorize a business-day close. */
export function isSalesSyncSourceComplete(evidence: SalesSyncCompletenessEvidence): boolean {
  return evidence.status === 'success'
    && evidence.limitReached === false
    && evidence.skippedDetailCount === 0
    && evidence.paymentSnapshotUnavailableCount === 0
    && evidence.receiptPaymentSourceComplete === true
    && evidence.partial === false
    && evidence.errorMessage == null;
}

export function syncRunCompletionEvidence(status: 'success' | 'failed', sourceComplete: boolean | undefined, errorMessage?: string) {
  const error_message = errorMessage ?? null;
  return { source_complete: status === 'success' && sourceComplete === true && error_message === null, error_message };
}
