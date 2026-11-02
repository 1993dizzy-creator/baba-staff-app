// Evidence assessment only. Never manufacture a provider revision from a local
// clock, page number, business date, hash, or BABA's administrator revision.
export const CUKCUK_SHADOW_SOURCE_CONTRACT = {
  identity: ["Company scope", "BranchId", "RefId"],
  providerSequenceVerified: false,
  snapshotTokenVerified: false,
  automaticConfirmation: false,
  documentation: "https://graphapi.cukcuk.vn/document/api/sainvoices_paging.html",
} as const;

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const first = (r: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (r[k] !== undefined && r[k] !== null) return r[k];
  return null;
};
export function hasExplicitEventTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const day = new Date(value.slice(0, 10) + "T00:00:00Z");
  return Number.isFinite(Date.parse(value)) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10);
}
export function assessCukcukShadowSource(payload: unknown, receivedAt: unknown) {
  const r = object(payload);
  const refId = first(r, ["RefId", "RefID", "refId", "refID"]);
  const branchId = first(r, ["BranchId", "BranchID", "branchId"]);
  const refDate = first(r, ["RefDate", "PostedDate", "refDate", "postedDate"]);
  const cancelDate = first(r, ["CancelDate", "cancelDate"]);
  const modifiedDate = first(r, ["ModifiedDate", "ModifiedDateUtc", "LastModifiedDate", "UpdatedDate"]);
  const candidateRevision = first(r, ["EditVersion", "Version", "Revision", "Sequence"]);
  const paymentStatus = first(r, ["PaymentStatus", "paymentStatus"]);
  const reasons = ["provider_revision_contract_unverified", "physical_movement_time_unproven", "closed_snapshot_contract_unverified"];
  if (typeof refId !== "string" || !refId.trim() || typeof branchId !== "string" || !branchId.trim()) reasons.push("source_identity_incomplete");
  if (!hasExplicitEventTime(refDate)) reasons.push("invoice_time_offset_unknown");
  if (!hasExplicitEventTime(receivedAt)) reasons.push("collection_time_unknown");
  return {
    status: "BLOCKED", automaticConfirmation: false, reasons,
    fields: { refId, branchId, refNo: first(r, ["RefNo", "refNo"]), paymentStatus,
      invoiceOccurredAt: refDate, cancelRecordedAt: cancelDate, modifiedDateCandidate: modifiedDate,
      revisionCandidate: candidateRevision, collectedAt: receivedAt },
    providerSequenceVerified: false, localRevisionIsProviderSequence: false,
    cancellationProvesPhysicalReturn: false, invoiceTimeProvesPhysicalMovementTime: false,
  };
}

export type RecoveryScan = {
  total: number | null;
  pages: { page: number; limit: number; refs: string[] }[];
  details: { refId: string; ok: boolean; semanticHash: string | null }[];
};
export type RecoveryManifest = {
  scope: { branchId: string; from: string; toExclusive: string };
  first: RecoveryScan; verification: RecoveryScan; localRefs: string[];
};
function scanEvidence(scan: RecoveryScan) {
  const reasons: string[] = [];
  const pages = [...scan.pages].sort((a, b) => a.page - b.page);
  const seen = new Set<string>(), duplicates = new Set<string>();
  const validTotal = typeof scan.total === "number" && Number.isSafeInteger(scan.total) && scan.total >= 0;
  if (!validTotal) reasons.push("source_count_unknown");
  if (!pages.length || pages.some((p, i) => p.page !== i + 1 || !Number.isSafeInteger(p.limit) || p.limit < 1 || p.limit > 100 || p.refs.length > p.limit)) reasons.push("page_chain_incomplete");
  if (pages.some((p, i) => p.limit !== pages[0]?.limit || (i < pages.length - 1 && p.refs.length !== p.limit))) reasons.push("page_shape_unstable");
  for (const p of pages) for (const ref of p.refs) {
    if (!ref.trim()) reasons.push("empty_source_identity");
    if (seen.has(ref)) duplicates.add(ref);
    seen.add(ref);
  }
  if (duplicates.size) reasons.push("duplicate_source_identity");
  if (validTotal && (seen.size !== scan.total || pages.length !== Math.max(1, Math.ceil(Number(scan.total) / (pages[0]?.limit || 100))))) reasons.push("source_count_mismatch");
  const detail = new Map<string, string>();
  for (const d of scan.details) {
    if (!seen.has(d.refId) || detail.has(d.refId)) reasons.push("detail_identity_conflict");
    if (d.ok && typeof d.semanticHash === "string" && /^[a-f0-9]{64}$/i.test(d.semanticHash)) detail.set(d.refId, d.semanticHash);
    else reasons.push("detail_unavailable");
  }
  const missingDetails = [...seen].filter(id => !detail.has(id)).sort();
  if (missingDetails.length) reasons.push("detail_missing");
  return { reasons, refs: [...seen].sort(), duplicates: [...duplicates].sort(), detail, missingDetails };
}

/** Read-only reconciliation plan, never a source_complete/watermark mutation. */
export function assessShadowRecovery(manifest: RecoveryManifest) {
  const a = scanEvidence(manifest.first), b = scanEvidence(manifest.verification);
  const reasons = [...a.reasons, ...b.reasons];
  if (!manifest.scope.branchId.trim() || !hasExplicitEventTime(manifest.scope.from) || !hasExplicitEventTime(manifest.scope.toExclusive) ||
      Date.parse(manifest.scope.from) >= Date.parse(manifest.scope.toExclusive)) reasons.push("invalid_fixed_scope");
  if (manifest.first.total !== manifest.verification.total || JSON.stringify(a.refs) !== JSON.stringify(b.refs)) reasons.push("source_changed_between_scans");
  const changed = a.refs.filter(id => a.detail.get(id) !== b.detail.get(id));
  if (changed.length) reasons.push("source_content_changed_between_scans");
  const local = new Set(manifest.localRefs);
  if (local.size !== manifest.localRefs.length) reasons.push("duplicate_local_identity");
  const missingLocally = b.refs.filter(id => !local.has(id));
  const locallyOnly = [...local].filter(id => !b.refs.includes(id)).sort();
  if (missingLocally.length || locallyOnly.length) reasons.push("local_source_identity_difference");
  return {
    mode: "shadow", enumerationStatus: reasons.length ? "BLOCKED" : "PASS",
    automaticConfirmation: false, transitionStatus: "BLOCKED", providerWindowScopeVerified: false,
    reasons: [...new Set(reasons)].sort(), missingLocally, locallyOnly, changed,
    missingDetails: [...new Set([...a.missingDetails, ...b.missingDetails])].sort(),
    duplicates: [...new Set([...a.duplicates, ...b.duplicates])].sort(),
    recovery: { scope: manifest.scope, refetchDetailIds: [...new Set([...b.refs, ...locallyOnly])].sort(),
      rescanAllPages: true, replayClosedWindow: true, deleteLocalRows: false,
      advanceWatermark: false, mutateInventory: false },
    unresolved: ["provider_revision_contract_unverified", "provider_window_semantics_unverified", "physical_event_timing_unverified", "writer_cutover_not_implemented"],
  };
}
