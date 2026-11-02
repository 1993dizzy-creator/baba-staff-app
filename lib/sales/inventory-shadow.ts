import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseServer } from "@/lib/supabase/server";
import { buildInventoryDeductionPreview } from "@/lib/sales/inventory-deduction-preview";

export type ShadowResult = Record<string, unknown>;
type Evidence = { proof?: string; timeBasis?: "physical_event" | "historical_correction" | "unknown" };
export type ShadowCaptureInput = Evidence & {
  receiptId: number;
  observationKey: string;
  sourceSequence: number | null;
  sourceComplete?: boolean;
  effectiveAt?: string | null;
  effectiveTimes?: Record<string, string>;
};

export function isInventoryShadowEnabled() {
  return process.env.POS_INVENTORY_SHADOW_MODE === "shadow";
}

export function shadowSqlState(error: unknown) {
  if (typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) return error.code;
  return "08006"; // An interrupted RPC has an unknown outcome; its lease is fenced.
}

async function rpc(name: string, args: Record<string, unknown>): Promise<ShadowResult> {
  const { data, error } = await supabaseServer.rpc(name, args);
  if (error) throw Object.assign(new Error("Shadow RPC failed."), { code: shadowSqlState(error) });
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw Object.assign(new Error("Invalid shadow RPC response."), { code: "XX000" });
  return data as ShadowResult;
}

// Explicit pilot entry point. No automatic hook is added to partially committed
// POS sync writes. sourceComplete and sourceSequence must come from a verified
// closed upstream observation; absent evidence is recorded as review, not guessed.
export async function captureInventoryShadow(input: ShadowCaptureInput, actor: string) {
  const first = await rpc("pos_shadow_read_receipt", { p_receipt: input.receiptId, p_actor: actor });
  let sourceComplete = input.sourceComplete === true;
  let sourceSequence = input.sourceSequence;
  let sourceReason: string | null = null;
  if ((first.snapshot as Record<string, unknown> | undefined)?.source === "cukcuk") {
    // P1-2D has no verified supplier sequence/completeness contract. A caller's
    // local revision or sourceComplete assertion cannot promote it to one.
    const intake = await rpc("pos_ingest_shadow_evidence", { p_receipt_id: input.receiptId }).catch(() => null);
    sourceComplete = false;
    sourceSequence = null;
    sourceReason = typeof intake?.blockingReason === "string" ? intake.blockingReason : "ingestion_evidence_unavailable";
  }
  const preview = await buildInventoryDeductionPreview({
    businessDateFrom: "1970-01-01", businessDateTo: "2999-12-31", receiptIds: [input.receiptId],
  });
  const receipt = preview.receipts.find(r => r.receiptId === input.receiptId);
  const after = await rpc("pos_shadow_read_receipt", { p_receipt: input.receiptId, p_actor: actor });
  if (first.snapshotKey !== after.snapshotKey || first.updatedAt !== after.updatedAt ||
      (receipt && (!receipt.previewedReceiptUpdatedAt || typeof first.updatedAt !== "string" ||
        Date.parse(receipt.previewedReceiptUpdatedAt) !== Date.parse(first.updatedAt))))
    return { result: "stale_observation", reason: "receipt_changed_during_preview" };

  const supported = new Set(["direct", "recipe", "option_direct", "option_recipe", "combo_direct", "combo_recipe", "combo_ignore", "ignore"]);
  const unsupported = !receipt || receipt.lines.some(line => line.isKegTracked ||
    !supported.has(line.lineType) || line.blocksReceipt || !line.refDetailId);
  const effects = (receipt?.lines ?? []).flatMap(line => line.deductions.map((d, index) => {
    const effectKey = [line.refDetailId, d.inventoryItemId, d.recipeId ?? "direct", index].join(":");
    return {
      effectKey, itemId: d.inventoryItemId, quantity: d.deductQuantity,
      effectiveAt: input.effectiveTimes?.[effectKey] ?? input.effectiveAt ?? null,
      mappingSnapshot: { ...line.mappingSnapshot, recipeId: d.recipeId, recipeVersion: d.recipeVersion,
        quantityPerUnit: d.deductQuantityPerUnit },
    };
  }));
  return rpc("pos_shadow_capture_version", {
    p_receipt_id: input.receiptId, p_expected_updated_at: first.updatedAt,
    p_observation_key: input.observationKey, p_source_sequence: sourceSequence,
    p_sale_snapshot: first.snapshot, p_effects: effects,
    p_evidence: { snapshotKey: first.snapshotKey, proof: input.proof ?? "",
      timeBasis: input.timeBasis ?? "unknown",
      blockingReason: sourceReason ?? (!sourceComplete ? "source_snapshot_incomplete" : unsupported ? "mapping_scope_unresolved" : null) },
    p_actor: actor,
  });
}

// Claim and completion are separate short RPCs. A process crash loses only a
// lease; generation + token fence every later completion/failure write.
export async function runInventoryShadow(actor: string, limit = 10, worker = `shadow:${randomUUID()}`) {
  const results: ShadowResult[] = [];
  for (let i = 0; i < Math.min(Math.max(limit, 1), 50); i++) {
    const claim = await rpc("pos_shadow_claim", { p_worker: worker, p_actor: actor });
    if (claim.result === "empty") break;
    if (claim.result !== "leased") throw Object.assign(new Error("Invalid shadow claim."), { code: "XX000" });
    try {
      results.push(await rpc("pos_shadow_settle", { p_job_id: claim.jobId, p_token: claim.token, p_actor: actor }));
    } catch (error) {
      const code = shadowSqlState(error);
      // Do not log SQL DETAIL or receipt payload. If this RPC also fails, lease
      // expiry remains the recovery path; no unowned job is overwritten.
      const recovery = await rpc("pos_shadow_fail", { p_job_id: claim.jobId, p_token: claim.token, p_sqlstate: code, p_actor: actor });
      results.push({ result: "processing_error", sqlState: code, jobId: claim.jobId, recovery });
    }
  }
  return { mode: "shadow", operatingInventoryWritten: false, results };
}

export async function inventoryShadowAction(action: string, body: Record<string, unknown>, actor: string): Promise<ShadowResult> {
  if (action === "capture") return captureInventoryShadow(body as unknown as ShadowCaptureInput, actor);
  if (action === "run") return runInventoryShadow(actor, typeof body.limit === "number" ? body.limit : 10);
  if (action === "compare") return rpc("pos_shadow_compare_item", { p_item: body.itemId, p_actor: actor });
  if (action === "retry") return rpc("pos_shadow_retry", { p_job_id: body.jobId, p_actor: actor });
  if (action === "status") return rpc("pos_shadow_job_status", { p_job: body.jobId, p_actor: actor });
  if (action === "movement") return rpc("pos_shadow_register_movement", {
    p_log_id: body.logId, p_kind: body.kind, p_effective_at: body.effectiveAt,
    p_evidence: { proof: body.proof, coverageComplete: body.coverageComplete === true }, p_actor: actor,
  });
  if (action === "resolve_timing") return rpc("pos_shadow_resolve_timing", {
    p_version: body.versionId, p_times: body.effectiveTimes,
    p_evidence: { proof: body.proof, timeBasis: body.timeBasis }, p_actor: actor,
  });
  if (action === "resolve_plan") return rpc("pos_shadow_resolve_physical_plan", {
    p_version: body.versionId, p_targets: body.targets, p_evidence: { proof: body.proof }, p_actor: actor,
  });
  if (action === "confirm_coverage") return rpc("pos_shadow_confirm_coverage", {
    p_log: body.logId, p_evidence: { proof: body.proof }, p_actor: actor,
  });
  throw Object.assign(new Error("Invalid shadow action."), { code: "22023" });
}
