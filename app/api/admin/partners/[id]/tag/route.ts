import { parseDisplayTag } from "@/lib/partners/policy";
import { partnerJson, requirePartnerManager } from "@/lib/partners/server";
import { supabaseServer } from "@/lib/supabase/server";

function parseId(raw: string) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Dedicated single-field mutation: intentionally does not call business_partner_update_v3,
// so saving a tag never overwrites payment/contact/settlement fields on the same partner.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePartnerManager();
  if (auth.response || !auth.actor) return auth.response;
  const id = parseId((await context.params).id);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const hasTag = body !== null && Object.prototype.hasOwnProperty.call(body, "displayTag");
  if (id === null || !hasTag) return partnerJson({ ok: false, code: "INVALID_BODY" }, 400);
  const displayTag = parseDisplayTag(body.displayTag);
  if (displayTag === undefined) return partnerJson({ ok: false, code: "INVALID_TAG" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("business_partner_update_display_tag_v1", {
      p_partner_id: id,
      p_display_tag: displayTag,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "updated") {
      const status = result.status === "not_found" ? 404 : result.status === "forbidden" ? 403 : 400;
      return partnerJson({ ok: false, code: String(result.status ?? "TAG_UPDATE_FAILED").toUpperCase() }, status);
    }
    return partnerJson({ ok: true, result });
  } catch (error) {
    console.error("[BUSINESS_PARTNER_TAG_UPDATE_FAILED]", error);
    return partnerJson({ ok: false, code: "PARTNER_TAG_UPDATE_FAILED" }, 500);
  }
}
