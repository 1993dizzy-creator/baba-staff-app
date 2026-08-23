import { parsePartnerInput } from "@/lib/partners/policy";
import { loadPartnerData, loadSupplierAliasInventory, loadSupplierAliases, partnerJson, requirePartnerManager } from "@/lib/partners/server";
import { supabaseServer } from "@/lib/supabase/server";

const parseId = (value: string) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePartnerManager();
  if (auth.response) return auth.response;
  const id = parseId((await context.params).id);
  if (id === null) return partnerJson({ ok: false, code: "INVALID_ALIAS_ID" }, 400);
  try {
    const [aliases, partnerData] = await Promise.all([loadSupplierAliases(), loadPartnerData()]);
    const alias = aliases.find(row => row.id === id);
    if (!alias) return partnerJson({ ok: false, code: "ALIAS_NOT_FOUND" }, 404);
    const inventoryItems = await loadSupplierAliasInventory(alias.supplierName);
    return partnerJson({ ok: true, alias, partners: partnerData.partners, fundAccounts: partnerData.fundAccounts, inventoryItems });
  } catch (error) {
    console.error("[SUPPLIER_ALIAS_LOAD_FAILED]", error);
    return partnerJson({ ok: false, code: "ALIAS_LOAD_FAILED" }, 500);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePartnerManager();
  if (auth.response || !auth.actor) return auth.response;
  const id = parseId((await context.params).id);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (id === null || !body || !["create_partner", "link_existing", "ignore", "reopen", "archive"].includes(String(body.action))) {
    return partnerJson({ ok: false, code: "INVALID_BODY" }, 400);
  }
  const action = String(body.action);

  if (action === "archive") {
    try {
      const { data, error } = await supabaseServer.rpc("business_partner_archive_supplier_alias_v1", {
        p_alias_id: id, p_actor_user_id: auth.actor.id,
      });
      if (error) throw error;
      const result = data as { status?: string };
      if (result.status !== "archived") {
        const status = result.status === "not_found" ? 404 : result.status === "forbidden" ? 403 : result.status === "candidate_in_use" ? 409 : 400;
        return partnerJson({ ok: false, code: String(result.status ?? "ARCHIVE_FAILED").toUpperCase() }, status);
      }
      return partnerJson({ ok: true, result });
    } catch (error) {
      console.error("[SUPPLIER_ALIAS_ARCHIVE_FAILED]", error);
      return partnerJson({ ok: false, code: "ALIAS_ARCHIVE_FAILED" }, 500);
    }
  }

  const partnerInput = action === "create_partner" ? parsePartnerInput(body.partner) : null;
  if (action === "create_partner" && !partnerInput) return partnerJson({ ok: false, code: "INVALID_PARTNER" }, 400);
  const existingPartnerId = action === "link_existing" ? Number(body.existingPartnerId) : null;
  if (action === "link_existing" && (!Number.isSafeInteger(existingPartnerId) || Number(existingPartnerId) < 1)) return partnerJson({ ok: false, code: "INVALID_PARTNER" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("business_partner_review_supplier_alias_v3", {
      p_alias_id: id, p_action: action, p_existing_partner_id: existingPartnerId,
      p_name: partnerInput?.name ?? null, p_partner_type: partnerInput?.partnerType ?? null,
      p_payment_mode: partnerInput?.paymentMode ?? null,
      p_settlement_mode: partnerInput?.settlementMode ?? null,
      p_settlement_rule: partnerInput?.settlementRule ?? null,
      p_default_payment_term_days: partnerInput?.defaultPaymentTermDays ?? null,
      p_default_fund_account_id: partnerInput?.defaultFundAccountId ?? null,
      p_phone: partnerInput?.phone ?? null, p_contact_name: partnerInput?.contactName ?? null,
      p_memo: partnerInput?.memo ?? null, p_actor_user_id: auth.actor.id,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "reviewed") {
      const status = result.status === "not_found" ? 404 : result.status === "forbidden" ? 403 : result.status === "duplicate_name" ? 409 : 400;
      return partnerJson({ ok: false, code: String(result.status ?? "REVIEW_FAILED").toUpperCase() }, status);
    }
    return partnerJson({ ok: true, result });
  } catch (error) {
    console.error("[SUPPLIER_ALIAS_REVIEW_FAILED]", error);
    return partnerJson({ ok: false, code: "ALIAS_REVIEW_FAILED" }, 500);
  }
}
