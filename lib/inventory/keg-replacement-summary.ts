import type { SupabaseClient } from "@supabase/supabase-js";
import { roundDecimal } from "@/lib/inventory/number";

type SupabaseClientLike = Pick<SupabaseClient, "from">;

export type PreviousKegSummary = {
  sessionId: number;
  startedAt: string | null;
  endedAt: string | null;
  capacityMl: number;
  soldMl: number;
  lossMl: number;
  usagePercent: number;
  lossPercent: number;
};

type ClosedKegSessionRow = {
  id: number | string;
  ended_log_id: number | string | null;
  started_at: string | null;
  ended_at: string | null;
  capacity_quantity: number | string | null;
  sold_quantity: number | string | null;
  loss_quantity: number | string | null;
};

const asNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Looks up the previous (closed) keg session for each keg_replace log so its
 * sold/remaining/loss figures can be shown alongside the "케그 교체" note.
 * Returns nothing for logs with no matching closed session (e.g. the very
 * first replacement, when there was no prior active session to close).
 */
export async function fetchPreviousKegSummariesByLogId(
  supabase: SupabaseClientLike,
  logIds: Array<number | string>
): Promise<Map<number, PreviousKegSummary>> {
  const summaryByLogId = new Map<number, PreviousKegSummary>();

  const safeLogIds = Array.from(
    new Set(
      logIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );

  if (safeLogIds.length === 0) return summaryByLogId;

  const { data, error } = await supabase
    .from("inventory_keg_sessions")
    .select(
      "id, ended_log_id, started_at, ended_at, capacity_quantity, sold_quantity, loss_quantity"
    )
    .eq("status", "closed")
    .in("ended_log_id", safeLogIds);

  if (error) throw error;

  for (const row of (data || []) as ClosedKegSessionRow[]) {
    const endedLogId = Number(row.ended_log_id);
    if (!Number.isFinite(endedLogId) || endedLogId <= 0) continue;
    if (row.sold_quantity === null || row.capacity_quantity === null) continue;

    const capacityMl = asNumber(row.capacity_quantity);
    const soldMl = asNumber(row.sold_quantity);
    const lossMl =
      row.loss_quantity === null
        ? Math.max(capacityMl - soldMl, 0)
        : asNumber(row.loss_quantity);

    summaryByLogId.set(endedLogId, {
      sessionId: Number(row.id),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      capacityMl,
      soldMl,
      lossMl,
      usagePercent: capacityMl > 0 ? roundDecimal((soldMl / capacityMl) * 100) : 0,
      lossPercent: capacityMl > 0 ? roundDecimal((lossMl / capacityMl) * 100) : 0,
    });
  }

  return summaryByLogId;
}
