import { loadLinkedPartnerPriceChanges, partnerJson, requirePartnerManager } from "@/lib/partners/server";
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
    const { data: partner, error } = await supabaseServer.from("business_partners").select("id").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!partner) return partnerJson({ ok: false, code: "PARTNER_NOT_FOUND" }, 404);
    const priceChanges = await loadLinkedPartnerPriceChanges(id);
    return partnerJson({ ok: true, priceChanges });
  } catch (error) {
    console.error("[BUSINESS_PARTNER_PRICE_CHANGES_LOAD_FAILED]", error);
    return partnerJson({ ok: false, code: "PARTNER_PRICE_CHANGES_LOAD_FAILED" }, 500);
  }
}
