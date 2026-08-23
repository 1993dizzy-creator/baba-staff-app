import { parsePartnerSubtypeUpdateInput } from "@/lib/partners/policy";
import { partnerJson, requirePartnerManager } from "@/lib/partners/server";
import { supabaseServer } from "@/lib/supabase/server";

function parseId(raw: string) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Edits name_ko/name_vi/sort_order/is_active only -- partner_type and code are immutable
// here. No DELETE handler: deactivate (isActive:false) is the only removal path, since a
// subtype may already be referenced by business_partners.partner_subtype_id.
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
