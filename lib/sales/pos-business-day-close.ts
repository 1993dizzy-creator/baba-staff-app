import "server-only";

import { getAuthenticatedActor } from "@/lib/auth/server-auth";
import { supabaseServer } from "@/lib/supabase/server";
import { loadPosBusinessDaySource } from "@/lib/ledger/pos-sales";
import { loadBusinessTimeAdapter, loadBusinessTimeSnapshotsForDates } from "@/lib/store-settings/business-time-adapter";
import { canWritePosBusinessDayClose, comparePosClosedSource, evaluatePosCloseTime, evaluatePosManualCloseTime, validatePosSystemActor } from "./pos-business-day-close-policy";
import { validPosBusinessDate } from "@/lib/ledger/pos-sales-source";

export async function resolvePosCloseSystemActor() {
  const { data, error } = await supabaseServer.from("users")
    .select("id,username,role,is_active,app_login_enabled").eq("username", "pos").maybeSingle();
  if (error) throw new Error("POS_CLOSE_SYSTEM_ACTOR_UNAVAILABLE");
  return validatePosSystemActor(data ? { ...data, id: Number(data.id) } : null);
}

export async function getPosBusinessDayCloseTime(businessDate: string, now = new Date()) {
  if (!validPosBusinessDate(businessDate)) throw new Error("INVALID_POS_BUSINESS_DATE");
  const [adapter, snapshots] = await Promise.all([
    loadBusinessTimeAdapter(now), loadBusinessTimeSnapshotsForDates([businessDate]),
  ]);
  const snapshot = snapshots.get(businessDate);
  if (!snapshot) throw new Error("POS_CLOSE_STORE_SETTING_UNAVAILABLE");
  return evaluatePosCloseTime(businessDate, adapter.databaseBusinessDate, now, snapshot);
}

export async function getPosBusinessDayManualCloseTime(businessDate: string, now = new Date()) {
  if (!validPosBusinessDate(businessDate)) throw new Error("INVALID_POS_BUSINESS_DATE");
  const [adapter, snapshots] = await Promise.all([
    loadBusinessTimeAdapter(now), loadBusinessTimeSnapshotsForDates([businessDate]),
  ]);
  const snapshot = snapshots.get(businessDate);
  if (!snapshot) throw new Error("POS_CLOSE_STORE_SETTING_UNAVAILABLE");
  return evaluatePosManualCloseTime(businessDate, adapter.databaseBusinessDate, now, snapshot);
}

async function requireCloseActor(write: boolean, reclose = false) {
  const auth = await getAuthenticatedActor();
  if (!auth.ok) throw new Error(auth.code);
  if (write ? !canWritePosBusinessDayClose(auth.actor.role, reclose) : !["owner", "master", "manager"].includes(auth.actor.role)) throw new Error("POS_CLOSE_FORBIDDEN");
  return auth.actor;
}

export async function getPosBusinessDayCloseStatus(businessDate: string) {
  const actor = await requireCloseActor(false);
  if (!validPosBusinessDate(businessDate)) throw new Error("INVALID_POS_BUSINESS_DATE");
  const [source, time, latest] = await Promise.all([
    loadPosBusinessDaySource(businessDate), getPosBusinessDayManualCloseTime(businessDate),
    supabaseServer.from("pos_sales_business_day_closures")
      .select("id,business_date,revision,close_method,closed_at,closed_by,sync_run_id,source_fingerprint,source_snapshot,ledger_result_snapshot,actor:users!closed_by(id,username,name,full_name,role)")
      .eq("business_date", businessDate).order("revision", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (latest.error) throw latest.error;
  const closure = latest.data;
  const comparison = comparePosClosedSource(source, closure?.source_snapshot, closure?.source_fingerprint ?? null);
  const { data: monthClosure, error } = await supabaseServer.from("ledger_month_closures")
    .select("id").eq("month", `${businessDate.slice(0, 7)}-01`).eq("status", "closed").maybeSingle();
  if (error) throw error;
  return { businessDate, source, closure, ...comparison, closedFingerprint: closure?.source_fingerprint ?? null,
    currentFingerprint: source.sourceFingerprint, monthClosed: Boolean(monthClosure),
    closeTime: time, canClose: canWritePosBusinessDayClose(actor.role) && time.allowed && !monthClosure && !comparison.isClosed,
    canReclose: canWritePosBusinessDayClose(actor.role, true) && time.allowed && !monthClosure && comparison.isClosed && comparison.drift };
}

async function closeWithActor(businessDate: string, actorId: number, options: {
  method: "manual" | "automatic"; reclose: boolean; expectedSourceFingerprint?: string; syncRunId?: number;
}) {
  const time = options.method === "manual"
    ? await getPosBusinessDayManualCloseTime(businessDate)
    : await getPosBusinessDayCloseTime(businessDate);
  if (!time.allowed) throw new Error("POS_CLOSE_BEFORE_CONFIGURED_CLOSE_TIME");
  const source = await loadPosBusinessDaySource(businessDate);
  if (options.expectedSourceFingerprint !== undefined && options.expectedSourceFingerprint !== source.sourceFingerprint) throw new Error("POS_CLOSE_SOURCE_CHANGED_SINCE_REVIEW");
  const { data, error } = await supabaseServer.rpc(options.method === "manual" && options.syncRunId !== undefined
    ? "sales_close_business_day_after_sync_v1" : "sales_close_business_day_v1", {
    p_business_date: businessDate, p_source_fingerprint: source.sourceFingerprint,
    p_source_snapshot: source.sourceSnapshot, p_rows: source.rows, p_actor_user_id: actorId,
    p_close_method: options.method, p_manual_reclose: options.reclose, p_sync_run_id: options.syncRunId ?? null,
  });
  if (error) throw error;
  return data as { status: "closed" | "reclosed" | "already_closed" | "source_changed_after_close" | "card_settlement_locked" | "month_closed" | "forbidden"; closureId?: number; revision?: number; ledgerResult?: Record<string, unknown> };
}

// Future UI entry point. Actor identity always comes from the server session.
export async function closePosBusinessDay(businessDate: string, options: {
  reclose?: boolean; expectedSourceFingerprint?: string; syncRunId?: number;
} = {}) {
  const actor = await requireCloseActor(true, options.reclose === true);
  return closeWithActor(businessDate, actor.id, { ...options, method: "manual", reclose: options.reclose === true });
}

// Internal automation entry point; no client-selected actor and no retry/cron
// orchestration yet. The DB verifies the supplied successful run and date.
export async function closePosBusinessDayAutomatically(businessDate: string, syncRunId: number) {
  if (!Number.isSafeInteger(syncRunId) || syncRunId < 1) throw new Error("POS_SALES_SUCCESSFUL_SYNC_RUN_REQUIRED");
  const actor = await resolvePosCloseSystemActor();
  return closeWithActor(businessDate, actor.id, { method: "automatic", reclose: false, syncRunId });
}
