import { parsePartnerSubtypeCreateInput } from "@/lib/partners/policy";
import { partnerJson, requirePartnerManager } from "@/lib/partners/server";
import { supabaseServer } from "@/lib/supabase/server";

// Subtype master CRUD (create/update/deactivate). Reload the list via GET
// /api/admin/partners (partnerSubtypes), same as every other partner mutation reload.
export async function POST(request: Request) {
  const auth = await requirePartnerManager();
  if (auth.response || !auth.actor) return auth.response;
  const input = parsePartnerSubtypeCreateInput(await request.json().catch(() => null));
  if (!input) return partnerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("business_partner_subtype_create_v1", {
      p_partner_type: input.partnerType,
      p_name_ko: input.nameKo,
      p_name_vi: input.nameVi,
      p_sort_order: input.sortOrder,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "created") {
      const status = result.status === "forbidden" ? 403 : 400;
      return partnerJson({ ok: false, code: String(result.status ?? "SUBTYPE_CREATE_FAILED").toUpperCase() }, status);
    }
    return partnerJson({ ok: true, result }, 201);
  } catch (error) {
    console.error("[PARTNER_SUBTYPE_CREATE_FAILED]", error);
    return partnerJson({ ok: false, code: "PARTNER_SUBTYPE_CREATE_FAILED" }, 500);
  }
}
