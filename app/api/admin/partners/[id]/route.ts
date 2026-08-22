import { parsePartnerInput } from "@/lib/partners/policy";
import { loadLinkedPartnerInventory, loadPartnerData, partnerJson, requirePartnerManager } from "@/lib/partners/server";
import { supabaseServer } from "@/lib/supabase/server";

function parseId(raw: string) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePartnerManager();
  if (auth.response) return auth.response;
  const id = parseId((await context.params).id);
  if (id === null) return partnerJson({ ok: false, code: "INVALID_PARTNER_ID" }, 400);
  try {
    const [data, linkedInventory] = await Promise.all([loadPartnerData(id), loadLinkedPartnerInventory(id)]);
    if (data.partners.length === 0) return partnerJson({ ok: false, code: "PARTNER_NOT_FOUND" }, 404);
    return partnerJson({ ok: true, partner: data.partners[0], ledgerParties: data.ledgerParties, linkedInventory });
  } catch (error) {
    console.error("[BUSINESS_PARTNER_LOAD_FAILED]", error);
    return partnerJson({ ok: false, code: "PARTNER_LOAD_FAILED" }, 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePartnerManager();
  if (auth.response || !auth.actor) return auth.response;
  const id = parseId((await context.params).id);
  const input = parsePartnerInput(await request.json().catch(() => null));
  if (id === null || !input) return partnerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("business_partner_update_v1", {
      p_partner_id: id,
      p_name: input.name,
      p_partner_type: input.partnerType,
      p_payment_mode: input.paymentMode,
      p_default_payment_term_days: input.defaultPaymentTermDays,
      p_phone: input.phone,
      p_contact_name: input.contactName,
      p_memo: input.memo,
      p_is_active: input.isActive,
      p_ledger_party_id: input.ledgerPartyId,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "updated") {
      const status = result.status === "not_found" ? 404 : result.status === "duplicate_name" || result.status === "ledger_party_already_linked" ? 409 : result.status === "forbidden" ? 403 : 400;
      return partnerJson({ ok: false, code: String(result.status ?? "UPDATE_FAILED").toUpperCase() }, status);
    }
    return partnerJson({ ok: true, result });
  } catch (error) {
    console.error("[BUSINESS_PARTNER_UPDATE_FAILED]", error);
    return partnerJson({ ok: false, code: "PARTNER_UPDATE_FAILED" }, 500);
  }
}
