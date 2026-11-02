import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { assessCukcukShadowSource, assessShadowRecovery, type RecoveryManifest } from "@/lib/pos/cukcuk/shadow-source-contract";

type Body = Record<string, unknown>;
async function call(name: string, args: Body) {
  const { data, error } = await supabaseServer.rpc(name, args);
  if (error) throw Object.assign(new Error("Shadow contract unavailable."), { code: error.code });
  return data;
}

export async function inventoryShadowReadiness(body: Body, actor: string) {
  switch (body.action) {
    case "gate": return {
      mode: "shadow", status: "BLOCKED", replacementAllowed: false,
      reasons: ["provider_revision_contract_unverified", "physical_event_timing_unverified",
        "all_writer_signed_balance_fence_missing", "operating_catalog_unverified"],
      operatingInventoryWritten: false,
    };
    case "source": {
      const { data, error } = await supabaseServer.from("pos_sales_receipts")
        .select("id,source,raw_json,synced_at,revision").eq("id", body.receiptId).maybeSingle();
      if (error) throw Object.assign(new Error("Source assessment unavailable."), { code: error.code });
      if (!data) return { status: "미확인", reason: "receipt_not_found" };
      return { mode: "shadow", ...assessCukcukShadowSource(data.raw_json, data.synced_at),
        source: data.source, localAdminRevision: data.revision ?? null };
    }
    case "writer": return call("pos_shadow_inventory_writer_contract", { p_log: body.logId, p_actor: actor });
    case "transfer_writer": return call("pos_shadow_register_writer_movement", {
      p_log: body.logId, p_expected_log_hash: body.expectedLogHash, p_kind: body.kind,
      p_effective_at: body.effectiveAt,
      p_evidence: { proof: body.proof, physicalEventRef: body.physicalEventRef ?? null,
        coverageComplete: body.coverageComplete === true }, p_actor: actor,
    });
    case "recovery": return assessShadowRecovery(body.manifest as RecoveryManifest);
    default: throw Object.assign(new Error("Invalid readiness action."), { code: "22023" });
  }
}
