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
// RPC recorded, purely for display. Historical opening/adjustment rows remain
// account-less; only contributions and explicitly tagged atomic recoveries move cash.
// Header-only summary for 장부작성's collapsed 투자금 현황. Same Source of Truth
// (ledger_owner_investments), same 03:00 month bounds and same "configured" rule
// as loadOwnerInvestmentMonth, but it reads only the selected month's rows: no
// prior history, users, account names, events or per-participant cumulatives.
export async function loadOwnerInvestmentMonthSummary(month: string): Promise<{ month: string; configured: boolean; periodNetChange: number }> {
  if (!OWNER_INVESTMENT_MONTH.test(month)) throw new Error("INVALID_MONTH");
  const { monthStartAt, nextMonthStartAt } = ownerInvestmentMonthBounds(month);
  const participants = await supabaseServer
    .from("ledger_owner_participants")
    .select("id,is_eligible,effective_from,effective_to");
  if (participants.error) throw participants.error;
  const configured = (participants.data ?? []).some((row) => isParticipantEffectiveForMonth(row, month));
  if (!configured) return { month, configured: false, periodNetChange: 0 };
  const periodResult = await supabaseServer
    .from("ledger_owner_investments")
    .select("id,participant_id,entry_type,signed_amount,occurred_at")
    .gte("occurred_at", monthStartAt)
    .lt("occurred_at", nextMonthStartAt);
  if (periodResult.error) throw periodResult.error;
  const { summary } = summarizeOwnerInvestments((periodResult.data ?? []) as OwnerInvestmentRow[], month);
  return { month, configured: true, periodNetChange: summary.periodNetChange };
}

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
    .select("id,user_id,sort_order,is_eligible,effective_from,effective_to");
  if (allParticipantsForConfig.error) throw allParticipantsForConfig.error;
  const activeParticipants = (allParticipantsForConfig.data ?? [])
    .filter((row) => isParticipantEffectiveForMonth(row, month))
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.id) - Number(b.id));
  const configured = activeParticipants.length > 0;
  if (!configured) return { month, configured: false, summary: ZERO_OWNER_INVESTMENT_SUMMARY, participants: [], events: [] };

  const investmentsResult = await supabaseServer
    .from("ledger_owner_investments")
    .select("id,participant_id,entry_type,signed_amount,occurred_at,reason,source_snapshot")
    .lt("occurred_at", nextMonthStartAt)
    .order("occurred_at", { ascending: true })
    .order("id", { ascending: true });
  if (investmentsResult.error) throw investmentsResult.error;
  const rows = (investmentsResult.data ?? []) as OwnerInvestmentDbRow[];
  const { summary, periodRows } = summarizeOwnerInvestments(rows, month);

  const participantIds = [...new Set(periodRows.map((row) => Number(row.participant_id)))].filter(
    (id) => !activeParticipants.some((participant) => Number(participant.id) === id),
  );
  const accountIds = [
    ...new Set(
      [
        ...periodRows.filter((row) => row.entry_type === "contribution"),
        ...periodRows.filter((row) => row.source_snapshot?.action === "recovery"),
      ]
        .map((row) => row.source_snapshot?.fundAccountId)
        .filter((id): id is number => typeof id === "number"),
    ),
  ];
  const [participantsResult, accountsResult] = await Promise.all([
    participantIds.length
      ? supabaseServer.from("ledger_owner_participants").select("id,user_id").in("id", participantIds)
      : Promise.resolve({ data: [] as Array<{ id: number; user_id: number }>, error: null }),
    accountIds.length
      ? supabaseServer.from("ledger_fund_accounts").select("id,display_name").in("id", accountIds)
      : Promise.resolve({ data: [] as Array<{ id: number; display_name: string }>, error: null }),
  ]);
  if (participantsResult.error) throw participantsResult.error;
  if (accountsResult.error) throw accountsResult.error;
  const participants = [...activeParticipants, ...(participantsResult.data ?? [])];
  const userIds = [...new Set(participants.map((row) => Number(row.user_id)))];
  const usersResult = userIds.length
    ? await supabaseServer.from("users").select("id,name,full_name,username").in("id", userIds)
    : { data: [] as Array<{ id: number; name: string | null; full_name: string | null; username: string | null }>, error: null };
  if (usersResult.error) throw usersResult.error;
  const userById = new Map((usersResult.data ?? []).map((row) => [Number(row.id), row]));
  const participantUser = new Map(participants.map((row) => [Number(row.id), Number(row.user_id)]));
  const accountById = new Map((accountsResult.data ?? []).map((row) => [Number(row.id), row.display_name as string]));
  const participantSummaries = activeParticipants.map((participant) => {
    const user = userById.get(Number(participant.user_id));
    return {
      participantId: Number(participant.id),
      participantName: user?.name || user?.full_name || user?.username || `#${participant.id}`,
      ...summarizeOwnerInvestments(rows.filter((row) => Number(row.participant_id) === Number(participant.id)), month).summary,
    };
  });

  const events: OwnerInvestmentEvent[] = periodRows.map((row) => {
    const userId = participantUser.get(Number(row.participant_id));
    const user = userId == null ? undefined : userById.get(userId);
    const rawFundAccountId = row.source_snapshot?.fundAccountId;
    const legacyFundAccountId = row.entry_type === "contribution" && typeof rawFundAccountId === "number" ? rawFundAccountId : null;
    const fundAccountId = row.source_snapshot?.action === "recovery" && typeof rawFundAccountId === "number"
      ? rawFundAccountId
      : legacyFundAccountId;
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
  return { month, configured: true, summary, participants: participantSummaries, events };
}
