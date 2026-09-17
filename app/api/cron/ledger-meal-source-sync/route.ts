import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/pos/cukcuk/sales-sync-cron-shared";
import { loadMealCandidateSource } from "@/lib/ledger/employee-costs";
import { previousVietnamBusinessDate, selectMealSyncActor, syncConfirmedMealSource } from "@/lib/ledger/meal-late-source-sync";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const guardResponse = authorizeCron(request);
  if (guardResponse) return guardResponse;

  const businessDate = previousVietnamBusinessDate(new Date());
  const month = businessDate.slice(0, 7);
  try {
    const { data: candidates, error: candidateError } = await supabaseServer
      .from("ledger_candidates")
      .select("status,source_key")
      .eq("candidate_type", "employee_meal")
      .eq("source_type", "attendance_meal_daily")
      .eq("status", "confirmed")
      .gte("business_date", `${month}-01`)
      .lte("business_date", businessDate);
    if (candidateError) throw candidateError;
    if (!candidates?.length) {
      return NextResponse.json({ ok: true, businessDate, month, noOp: "no_confirmed_candidate" });
    }

    const { data: actors, error: actorError } = await supabaseServer
      .from("users")
      .select("id,role")
      .in("role", ["owner", "master"])
      .eq("is_active", true)
      .eq("app_login_enabled", true)
      .order("id");
    if (actorError) throw actorError;
    const actor = selectMealSyncActor(actors ?? []);
    if (!actor) {
      return NextResponse.json({ ok: false, code: "NO_LEDGER_ACTOR" }, { status: 422 });
    }

    const result = await syncConfirmedMealSource({
      month,
      latestBusinessDate: businessDate,
      candidates: candidates.map((candidate) => ({ status: candidate.status, sourceKey: candidate.source_key })),
      loadRows: async (sourceMonth) => (await loadMealCandidateSource(sourceMonth)).rows,
      syncRows: async (rows) => {
        const { data, error } = await supabaseServer.rpc("ledger_sync_candidates_v2", {
          p_candidate_type: "employee_meal",
          p_source_type: "attendance_meal_daily",
          p_rows: rows,
          p_actor_user_id: actor.id,
        });
        if (error) throw error;
        return data as { status: string; driftCount?: number };
      },
    });
    return NextResponse.json({ ok: true, businessDate, month, ...result });
  } catch (error) {
    console.error("[LEDGER_MEAL_SOURCE_SYNC_FAILED]", error);
    return NextResponse.json({ ok: false, code: "LEDGER_MEAL_SOURCE_SYNC_FAILED" }, { status: 500 });
  }
}
