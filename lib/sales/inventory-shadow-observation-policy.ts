// Observation disposition only. It never interprets a legacy reversal as goods returned.
export type DeductionEvidence = {
  id: number; operation_type: string | null; status: string | null;
  applied_at: string | null; inventory_log_id: number | null;
  reversal_of_deduction_id: number | null; batch_receipt_id: number | null;
};
export function classifyObservationHistory(rows: DeductionEvidence[], workflows: Record<string, string>, incomplete = false) {
  const reasons = ["provider_completeness_unverified", "external_writer_coverage_unverified", "unit_and_physical_time_evidence_required"];
  let disposition: "signed_candidate" | "raw_only" | "uncertain" = "signed_candidate";
  const executed = rows.filter(d => ["applied", "success", "reverted"].includes(d.status ?? "") || d.applied_at != null || d.inventory_log_id != null);
  const reversals = executed.filter(d => d.operation_type === "revert");
  const targets = new Set<number>();
  if (incomplete) { reasons.push("history_incomplete_or_unavailable"); disposition = "uncertain"; }
  if (rows.some(d => d.operation_type === "revert" && !executed.includes(d))) { reasons.push("unexecuted_reversal_attempt_requires_review"); disposition = "uncertain"; }
  for (const d of executed) if (d.inventory_log_id == null) { reasons.push("executed_audit_link_missing"); disposition = "uncertain"; }
  for (const d of reversals) {
    if (disposition !== "uncertain") disposition = "raw_only";
    const original = executed.find(o => o.id === d.reversal_of_deduction_id && o.operation_type !== "revert");
    if (!original || targets.has(d.reversal_of_deduction_id!)) {
      reasons.push(original ? "duplicate_executed_reversal" : "reversal_original_missing"); disposition = "uncertain";
    }
    if (d.reversal_of_deduction_id !== null) targets.add(d.reversal_of_deduction_id);
    const workflow = workflows[String(d.batch_receipt_id)];
    reasons.push(workflow === "reprocess_modified" ? "legacy_reprocess_baseline_requires_reconciliation"
      : workflow === "rollback_canceled" ? "economic_cancel_is_not_physical_return" : "reversal_workflow_unproven");
    if (!workflow || !["reprocess_modified", "rollback_canceled"].includes(workflow)) disposition = "uncertain";
  }
  return { disposition, reasons: [...new Set(reasons)], executedCount: executed.length, reversalCount: reversals.length,
    signedAdoptionAllowed: disposition === "signed_candidate", rawObservationAllowed: true,
    sourceComplete: false, writerCoverageComplete: false, automaticConfirmation: false, inventoryWritten: false };
}
