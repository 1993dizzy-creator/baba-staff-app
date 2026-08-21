import { LEDGER_MONTH } from "@/lib/ledger/inventory-candidates";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const STATUSES = new Set(["pending", "confirmed", "dismissed", "superseded"]);
const TYPES = new Set(["all", "inventory_purchase", "employee_meal", "payroll_employee_payment", "source_drift"]);

export async function GET(request: Request) {
  const auth = await requireLedgerActor(); if (auth.response) return auth.response;
  const params = new URL(request.url).searchParams;
  const month = params.get("month") ?? ""; const status = params.get("status") ?? "pending"; const type = params.get("type") ?? "inventory_purchase";
  if (!LEDGER_MONTH.test(month) || !STATUSES.has(status) || !TYPES.has(type)) return ledgerJson({ ok: false, code: "INVALID_FILTER" }, 400);
  const start = `${month}-01`; const next = new Date(`${start}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  let query = supabaseServer.from("ledger_candidates")
    .select("id,candidate_type,source_type,source_key,business_date,proposed_amount,proposed_category_id,proposed_party_id,proposed_recognition_month,source_snapshot,source_fingerprint,status,dismissal_reason,created_at,category:ledger_categories(name),party:ledger_parties(name)")
    .eq("status", status).gte("business_date", start).lt("business_date", next.toISOString().slice(0, 10)).order("business_date", { ascending: false }).order("id", { ascending: false });
  if(type!=="all")query=query.eq("candidate_type",type);
  const { data, error } = await query;
  if (error) { console.error("[LEDGER_CANDIDATES_GET_FAILED]", error); return ledgerJson({ ok: false, code: "CANDIDATES_LOAD_FAILED" }, 500); }
  return ledgerJson({ ok: true, candidates: data ?? [] });
}
