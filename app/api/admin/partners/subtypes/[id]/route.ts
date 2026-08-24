import { parsePartnerSubtypeUpdateInput } from "@/lib/partners/policy";
import { partnerJson, requirePartnerManager } from "@/lib/partners/server";
import { supabaseServer } from "@/lib/supabase/server";

function parseId(raw: string) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Edits name_ko/name_vi/sort_order/is_active only -- partner_type and code are immutable.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePartnerManager();
  if (auth.response || !auth.actor) return auth.response;
  const id = parseId((await context.params).id);
  const input = parsePartnerSubtypeUpdateInput(await request.json().catch(() => null));
  if (id === null || !input) return partnerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("business_partner_subtype_update_v1", {
      p_subtype_id: id,
      p_name_ko: input.nameKo,
      p_name_vi: input.nameVi,
      p_sort_order: input.sortOrder,
      p_is_active: input.isActive,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "updated") {
      const status = result.status === "not_found" ? 404 : result.status === "forbidden" ? 403 : 400;
      return partnerJson({ ok: false, code: String(result.status ?? "SUBTYPE_UPDATE_FAILED").toUpperCase() }, status);
    }
    return partnerJson({ ok: true, result });
  } catch (error) {
    console.error("[PARTNER_SUBTYPE_UPDATE_FAILED]", error);
    return partnerJson({ ok: false, code: "PARTNER_SUBTYPE_UPDATE_FAILED" }, 500);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePartnerManager();
  if (auth.response || !auth.actor) return auth.response;
  const id = parseId((await context.params).id);
  if (id === null) return partnerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    // Helpful early response only; the RPC repeats this check under locking and is the
    // authoritative guard against concurrent Partner writes.
    const { count, error: countError } = await supabaseServer
      .from("business_partners")
      .select("id", { count: "exact", head: true })
      .eq("partner_subtype_id", id);
    if (countError) throw countError;
    if ((count ?? 0) > 0) return partnerJson({ ok: false, code: "SUBTYPE_IN_USE" }, 409);

    const { data, error } = await supabaseServer.rpc("business_partner_subtype_delete_v1", {
      p_subtype_id: id,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "deleted") {
      const status = result.status === "not_found" ? 404 : result.status === "in_use" ? 409 : result.status === "forbidden" ? 403 : 400;
      const code = result.status === "in_use" ? "SUBTYPE_IN_USE" : result.status === "not_found" ? "SUBTYPE_NOT_FOUND" : String(result.status ?? "SUBTYPE_DELETE_FAILED").toUpperCase();
      return partnerJson({ ok: false, code }, status);
    }
    return partnerJson({ ok: true, result });
  } catch (error) {
    console.error("[PARTNER_SUBTYPE_DELETE_FAILED]", error);
    return partnerJson({ ok: false, code: "PARTNER_SUBTYPE_DELETE_FAILED" }, 500);
  }
}
