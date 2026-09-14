import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { getBusinessDate } from "@/lib/common/business-time";
import {
  OWNER_INVESTMENT_MONTH,
  ZERO_OWNER_INVESTMENT_SUMMARY,
  isParticipantEffectiveForMonth,
  ownerInvestmentMonthBounds,
  summarizeOwnerInvestments,
  type OwnerInvestmentEvent,
  type OwnerInvestmentMonthData,
  type OwnerInvestmentRow,
} from "@/lib/ledger/investments";

type OwnerInvestmentDbRow = OwnerInvestmentRow & {
  reason: string | null;
  source_snapshot: Record<string, unknown> | null;
};

// Source of truth is ledger_owner_investments alone. A contribution's linked
// transaction/movement is never re-summed here (that would double-count the same
// amount) — the only thing read from source_snapshot is the fund account id the
// RPC recorded, purely for display, and only for entry_type='contribution'
// (opening/adjustment never move funds, so any account value they might carry is
// display-irrelevant and must never be surfaced).
export async function loadOwnerInvestmentMonth(month: string): Promise<OwnerInvestmentMonthData> {
  if (!OWNER_INVESTMENT_MONTH.test(month)) throw new Error("INVALID_MONTH");
  const { nextMonthStartAt } = ownerInvestmentMonthBounds(month);

  // "configured" asks whether an eligible participant was actually effective
  // DURING the selected month — not merely whether any participant row exists
  // anywhere in time (see isParticipantEffectiveForMonth: same selected-month
  // contract lib/ledger/owners.ts already uses, so August stays "not configured"
  // even if a September-onward participant already exists). The participants
  // table only ever holds a handful of rows (at most 3 concurrent owners plus
  // their history), so fetching all of them here and filtering in JS is cheap
  // and keeps the eligibility rule in one directly-testable place.
  const allParticipantsForConfig = await supabaseServer
    .from("ledger_owner_participants")
    .select("is_eligible,effective_from,effective_to");
  if (allParticipantsForConfig.error) throw allParticipantsForConfig.error;
  const configured = (allParticipantsForConfig.data ?? []).some((row) => isParticipantEffectiveForMonth(row, month));
  if (!configured) return { month, configured: false, summary: ZERO_OWNER_INVESTMENT_SUMMARY, events: [] };

  const investmentsResult = await supabaseServer
    .from("ledger_owner_investments")
    .select("id,participant_id,entry_type,signed_amount,occurred_at,reason,source_snapshot")
    .lt("occurred_at", nextMonthStartAt)
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true });
  if (investmentsResult.error) throw investmentsResult.error;
  const rows = (investmentsResult.data ?? []) as OwnerInvestmentDbRow[];
  const { summary, periodRows } = summarizeOwnerInvestments(rows, month);
  if (periodRows.length === 0) return { month, configured: true, summary, events: [] };

  const participantIds = [...new Set(periodRows.map((row) => Number(row.participant_id)))];
  const accountIds = [
    ...new Set(
      periodRows
        .filter((row) => row.entry_type === "contribution")
        .map((row) => row.source_snapshot?.fundAccountId)
        .filter((id): id is number => typeof id === "number"),
    ),
  ];
  const [participantsResult, accountsResult] = await Promise.all([
    supabaseServer.from("ledger_owner_participants").select("id,user_id").in("id", participantIds),
    accountIds.length
      ? supabaseServer.from("ledger_fund_accounts").select("id,display_name").in("id", accountIds)
      : Promise.resolve({ data: [] as Array<{ id: number; display_name: string }>, error: null }),
  ]);
  if (participantsResult.error) throw participantsResult.error;
  if (accountsResult.error) throw accountsResult.error;
  const participants = participantsResult.data ?? [];
  const userIds = [...new Set(participants.map((row) => Number(row.user_id)))];
  const usersResult = userIds.length
    ? await supabaseServer.from("users").select("id,name,full_name,username").in("id", userIds)
    : { data: [] as Array<{ id: number; name: string | null; full_name: string | null; username: string | null }>, error: null };
  if (usersResult.error) throw usersResult.error;
  const userById = new Map((usersResult.data ?? []).map((row) => [Number(row.id), row]));
  const participantUser = new Map(participants.map((row) => [Number(row.id), Number(row.user_id)]));
  const accountById = new Map((accountsResult.data ?? []).map((row) => [Number(row.id), row.display_name as string]));

  const events: OwnerInvestmentEvent[] = periodRows.map((row) => {
    const userId = participantUser.get(Number(row.participant_id));
    const user = userId == null ? undefined : userById.get(userId);
    const rawFundAccountId = row.source_snapshot?.fundAccountId;
    const fundAccountId = row.entry_type === "contribution" && typeof rawFundAccountId === "number" ? rawFundAccountId : null;
    return {
      investmentId: Number(row.id),
      participantId: Number(row.participant_id),
      participantName: user?.name || user?.full_name || user?.username || `#${row.participant_id}`,
      entryType: row.entry_type,
      amount: Number(row.signed_amount),
      businessDate: getBusinessDate(new Date(row.occurred_at)),
      occurredAt: row.occurred_at,
      fundAccountId,
      fundAccountName: fundAccountId == null ? null : accountById.get(fundAccountId) ?? null,
      reason: row.reason ?? null,
    };
  });
  return { month, configured: true, summary, events };
}
