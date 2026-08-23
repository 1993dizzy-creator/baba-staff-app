import { parsePartnerInput } from "@/lib/partners/policy";
import { loadPartnerData, loadSupplierAliases, partnerJson, requirePartnerManager } from "@/lib/partners/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requirePartnerManager();
  if (auth.response) return auth.response;
  try {
    const [partnerData, supplierAliases] = await Promise.all([loadPartnerData(), loadSupplierAliases()]);
    return partnerJson({ ok: true, ...partnerData, supplierAliases });
  } catch (error) {
    console.error("[BUSINESS_PARTNERS_LOAD_FAILED]", error);
    return partnerJson({ ok: false, code: "PARTNERS_LOAD_FAILED" }, 500);
  }
}

export async function POST(request: Request) {
  const auth = await requirePartnerManager();
  if (auth.response || !auth.actor) return auth.response;
  const input = parsePartnerInput(await request.json().catch(() => null));
  if (!input) return partnerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("business_partner_create_v3", {
      p_name: input.name,
      p_partner_type: input.partnerType,
      p_payment_mode: input.paymentMode,
      p_settlement_mode: input.settlementMode,
      p_settlement_rule: input.settlementRule,
      p_default_payment_term_days: input.defaultPaymentTermDays,
      p_default_fund_account_id: input.defaultFundAccountId,
      p_phone: input.phone,
      p_contact_name: input.contactName,
      p_memo: input.memo,
      p_is_active: input.isActive,
      p_ledger_party_id: input.ledgerPartyId,
      p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "created") {
      const status = result.status === "duplicate_name" || result.status === "ledger_party_already_linked" ? 409 : result.status === "forbidden" ? 403 : 400;
      return partnerJson({ ok: false, code: String(result.status ?? "CREATE_FAILED").toUpperCase() }, status);
    }
    return partnerJson({ ok: true, result }, 201);
  } catch (error) {
    console.error("[BUSINESS_PARTNER_CREATE_FAILED]", error);
    return partnerJson({ ok: false, code: "PARTNER_CREATE_FAILED" }, 500);
  }
}
