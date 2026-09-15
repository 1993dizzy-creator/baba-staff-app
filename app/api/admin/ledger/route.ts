import { calculateCardGross, sumCardMoney } from "@/lib/ledger/card-settlements";
import { loadCardRows, loadCardSales, loadCardAllocationLines } from "@/lib/ledger/card-settlement-data";
import { supabaseServer } from "@/lib/supabase/server";
import { withInventoryDisplay, loadInventoryProjectionIssues } from "@/lib/ledger/inventory-display";
import { buildLedgerEntries, type CandidateRow, type MealCandidateSource, type PartnerLedgerDefault, type TransactionRow } from "@/lib/ledger/entries";
import { ledgerJson, requireLedgerActor } from "@/lib/ledger/server";
import { computePaidExpenseTotal } from "@/lib/ledger/payables";
import { reservesByFundAccount } from "@/lib/ledger/reserve-balances";
import { computeReceivedIncome } from "@/lib/ledger/summary";
import { getBusinessDate, getBusinessMonthEndBoundary } from "@/lib/common/business-time";
import { buildFundAccountView, fundAccountViewMode } from "@/lib/ledger/fund-account-view";

export const dynamic = "force-dynamic";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TYPES = new Set(["expense", "income", "transfer", "balance_adjustment"]);
const TRANSACTION_SELECT = "id,operation_id,type,occurred_at,business_date,recognition_month,amount,economic_effect_sign,correction_of_id,status,source_type,source_key,source_snapshot,source_synced_at,memo,party_id,category:ledger_categories(id,name,kind),party:ledger_parties(name),movements:ledger_movements(amount,fund_account:ledger_fund_accounts(id,display_name)),payable:ledger_payables(id,due_date,status,allocations:ledger_payable_allocations(allocated_amount))";

export async function GET(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response) return auth.response;
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!MONTH.test(month)) return ledgerJson({ ok: false, code: "INVALID_MONTH" }, 400);
  const monthStart = `${month}-01`;
  const { businessDateExclusive: nextMonth, cutoffAt: monthEndCutoffAt } = getBusinessMonthEndBoundary(month);

  try {
    const now = new Date();
    const currentBusinessDate = getBusinessDate(now);
    const closureResult = month === currentBusinessDate.slice(0, 7)
      ? { data: null, error: null }
      : await supabaseServer.from("ledger_month_closures")
          .select("status,summary_snapshot")
          .eq("month", monthStart)
          .eq("status", "closed")
          .maybeSingle();
    if (closureResult.error) throw closureResult.error;
    const fundsViewMode = fundAccountViewMode(month, currentBusinessDate, Boolean(closureResult.data));
    const accountsPromise = supabaseServer.from("ledger_fund_accounts").select("id,code,type,holder_name,display_name,is_active,is_business_fund,sort_order").order("sort_order");
    const categoriesPromise = supabaseServer.from("ledger_categories").select("id,name,kind,parent_id,cost_behavior,is_active,parent:ledger_categories!parent_id(name)").eq("is_active", true).order("kind").order("name");
    const partiesPromise = supabaseServer.from("ledger_parties").select("id,name,type,is_active").eq("is_active", true).order("name");
    const partnerPromise = supabaseServer.from("business_partners").select("id,name,payment_mode,default_fund_account_id,is_active").order("name");
    const bridgePromise = supabaseServer.from("business_partner_ledger_parties").select("business_partner_id,ledger_party_id");
    const profitPromise = supabaseServer.from("ledger_transactions").select("type,amount,economic_effect_sign").eq("status", "confirmed").gte("recognition_month", monthStart).lt("recognition_month", nextMonth).in("type", ["income", "expense", "sales"]);
    const recognitionProfitPromise = supabaseServer.from("ledger_transactions").select("type,amount,economic_effect_sign").eq("status", "confirmed").gte("recognition_month", monthStart).lt("recognition_month", nextMonth).eq("type", "expense_recognition");
    const movementsQuery = supabaseServer.from("ledger_movements").select("fund_account_id,amount,transaction:ledger_transactions!inner(status,occurred_at,business_date)").eq("transaction.status", "confirmed");
    const movementsPromise = fundsViewMode === "closed_snapshot"
      ? Promise.resolve({ data: [], error: null })
      : fundsViewMode === "live"
        ? movementsQuery.lte("transaction.occurred_at", now.toISOString())
        : movementsQuery.lt("transaction.business_date", nextMonth);
    const openingPromise = supabaseServer.from("ledger_movements").select("fund_account_id,amount,transaction:ledger_transactions!inner(status,type,business_date,source_type)").eq("transaction.status", "confirmed").eq("transaction.type", "opening").eq("transaction.business_date", monthStart);
    // Card gross sales: this month's POS card-bucket sales (business_date scoped), before card-company fees.
    const cardGrossSalesPromise = loadCardSales(monthStart, nextMonth);
    // Actual card deposits: this month's real bank deposits from the card company (deposit_date scoped, not the sale's month).
    const actualCardDepositsPromise = loadCardRows((from, to) => supabaseServer.from("ledger_card_reconciliations").select("deposit_amount").neq("status", "cancelled").gte("deposit_date", monthStart).lt("deposit_date", nextMonth).order("id").range(from, to));
    const reservesPromise = fundsViewMode === "closed_snapshot"
      ? Promise.resolve({ data: [], error: null })
      : supabaseServer.from("ledger_reserve_plans")
          .select("id,name,is_active,fund_account_id,linked_recurring_plan:ledger_recurring_expense_plans(source_key_prefix)")
          .order("id");
    const reserveEntriesQuery = supabaseServer.from("ledger_reserve_entries")
      .select("reserve_plan_id,entry_type,amount,occurred_at");
    const reserveEntriesPromise = fundsViewMode === "closed_snapshot"
      ? Promise.resolve({ data: [], error: null })
      : fundsViewMode === "live"
        ? reserveEntriesQuery.lte("occurred_at", now.toISOString())
        : reserveEntriesQuery.lt("occurred_at", monthEndCutoffAt);
    // Root expense/expense_recognition transactions recognized this month, with their
    // linked payable (if any) — the base population for the paidExpense formula below.
    const paidExpenseRootsPromise = supabaseServer.from("ledger_transactions").select("id,amount,economic_effect_sign,source_type,correction_of_id,payable:ledger_payables(status,allocations:ledger_payable_allocations(allocated_amount))").eq("status", "confirmed").gte("recognition_month", monthStart).lt("recognition_month", nextMonth).in("type", ["expense", "expense_recognition"]);
    // Confirmed corrections targeting ANY transaction (not date-scoped: ledger_create_correction_v1
    // always books a correction into a different, later month than its — closed — original, so a
    // correction of this month's root can itself be recognized in any later open month).
    const paidExpenseCorrectionsPromise = supabaseServer.from("ledger_transactions").select("correction_of_id,amount,economic_effect_sign").eq("status", "confirmed").eq("source_type", "ledger_correction").not("correction_of_id", "is", null);
    const confirmedMealCandidatesPromise = supabaseServer.from("ledger_candidates")
      .select("resolved_transaction_id,source_snapshot,source_drift_snapshot")
      .eq("candidate_type", "employee_meal").eq("source_type", "attendance_meal_daily")
      .eq("status", "confirmed").gte("business_date", monthStart).lt("business_date", nextMonth)
      .not("resolved_transaction_id", "is", null);
    const [accountsResult, categoriesResult, partiesResult, partnerResult, bridgeResult, profitResult, recognitionProfitResult, movementsResult, openingResult, cardGrossSalesResult, actualCardDepositsResult, reservesResult, reserveEntriesResult, paidExpenseRootsResult, paidExpenseCorrectionsResult, confirmedMealCandidatesResult, transactions, candidates] = await Promise.all([
      accountsPromise, categoriesPromise, partiesPromise, partnerPromise, bridgePromise, profitPromise,
      recognitionProfitPromise, movementsPromise, openingPromise, cardGrossSalesPromise, actualCardDepositsPromise, reservesPromise, reserveEntriesPromise, paidExpenseRootsPromise, paidExpenseCorrectionsPromise,
      confirmedMealCandidatesPromise, loadMonthTransactions(monthStart, nextMonth), loadPendingInventoryCandidates(monthStart, nextMonth),
    ]);
    for (const result of [accountsResult,categoriesResult,partiesResult,partnerResult,bridgeResult,profitResult,recognitionProfitResult,movementsResult,openingResult,reservesResult,reserveEntriesResult,paidExpenseRootsResult,paidExpenseCorrectionsResult,confirmedMealCandidatesResult]) if (result.error) throw result.error;
    const profitRows=[...(profitResult.data??[]),...(recognitionProfitResult.data??[])];
    const recognizedIncome = profitRows.filter((row) => row.type === "income" || row.type === "sales").reduce((sum,row) => sum + Number(row.amount) * Number(row.economic_effect_sign ?? 1),0);
    const expense = profitRows.filter((row) => row.type === "expense" || row.type === "expense_recognition").reduce((sum,row) => sum + Number(row.amount) * Number(row.economic_effect_sign ?? 1),0);
    const lines = await loadCardAllocationLines(cardGrossSalesResult.map(row => Number(row.id)));
    const cardGross = calculateCardGross(cardGrossSalesResult, lines, monthStart, nextMonth);
    const cardGrossSales = cardGross.monthlyCardGross;
    const reconciledCardGross = cardGross.monthlyReconciledGross;
    const unreconciledCardGross = cardGross.monthlyUnreconciledGross;
    const actualCardDeposits = sumCardMoney(actualCardDepositsResult.map(row => row.deposit_amount));
    const unsettledCardGross = unreconciledCardGross;
    const receivedIncome = computeReceivedIncome(recognizedIncome, cardGrossSales, actualCardDeposits);
    const correctionsByRoot = new Map<number, { amount: number; economicEffectSign: number }[]>();
    for (const row of paidExpenseCorrectionsResult.data ?? []) {
      const key = Number(row.correction_of_id);
      const list = correctionsByRoot.get(key) ?? [];
      list.push({ amount: Number(row.amount), economicEffectSign: Number(row.economic_effect_sign) });
      correctionsByRoot.set(key, list);
    }
    const paidExpenseRoots = (paidExpenseRootsResult.data ?? []).map((row) => ({
      id: Number(row.id),
      amount: Number(row.amount),
      economicEffectSign: Number(row.economic_effect_sign),
      sourceType: String(row.source_type),
      correctionOfId: row.correction_of_id == null ? null : Number(row.correction_of_id),
      payableStatus: (row.payable as unknown as { status: string; allocations?: { allocated_amount: number }[] } | null)?.status ?? null,
      allocatedAmount: ((row.payable as unknown as { status: string; allocations?: { allocated_amount: number }[] } | null)?.allocations ?? []).reduce((sum, allocation) => sum + Number(allocation.allocated_amount), 0),
      corrections: correctionsByRoot.get(Number(row.id)) ?? [],
    }));
    const paidExpense = computePaidExpenseTotal(paidExpenseRoots);
    const reserveEntriesByPlan = new Map<number, Array<{ entry_type: string; amount: number | string }>>();
    for (const entry of reserveEntriesResult.data ?? []) {
      const planId = Number(entry.reserve_plan_id);
      const entries = reserveEntriesByPlan.get(planId) ?? [];
      entries.push({ entry_type: entry.entry_type, amount: entry.amount });
      reserveEntriesByPlan.set(planId, entries);
    }
    const reservePlans = (reservesResult.data ?? []).map((plan) => ({
      ...plan,
      entries: reserveEntriesByPlan.get(Number(plan.id)) ?? [],
    }));
    const accounts = buildFundAccountView({
      accounts: accountsResult.data ?? [],
      openingMovements: openingResult.data ?? [],
      movements: movementsResult.data ?? [],
      reservePlans,
      groupReserves: reservesByFundAccount,
      mode: fundsViewMode,
      closeSummary: closureResult.data?.summary_snapshot as Parameters<typeof buildFundAccountView>[0]["closeSummary"],
    });
    const accountById = new Map(accounts.map(account => [Number(account.id), account]));
    const partnerById = new Map((partnerResult.data ?? []).map(partner => [Number(partner.id), partner]));
    const partnerDefaultsByParty = new Map<number, PartnerLedgerDefault>();
    const partners = (bridgeResult.data ?? []).flatMap(bridge => {
      const partner = partnerById.get(Number(bridge.business_partner_id));
      if (!partner) return [];
      const defaultFundAccountId = partner.default_fund_account_id === null ? null : Number(partner.default_fund_account_id);
      partnerDefaultsByParty.set(Number(bridge.ledger_party_id), {
        paymentMode: partner.payment_mode, defaultFundAccountId,
        defaultFundAccountName: defaultFundAccountId === null ? null : accountById.get(defaultFundAccountId)?.display_name ?? null,
      });
      return [{ id: Number(partner.id), name: partner.name, ledgerPartyId: Number(bridge.ledger_party_id), paymentMode: partner.payment_mode, defaultFundAccountId, isActive: partner.is_active }];
    });
    const mealCandidateSources: MealCandidateSource[] = (confirmedMealCandidatesResult.data ?? []).map((candidate) => ({
      resolvedTransactionId: Number(candidate.resolved_transaction_id),
      sourceSnapshot: candidate.source_snapshot as Record<string, unknown> | null,
      sourceDriftSnapshot: candidate.source_drift_snapshot as Record<string, unknown> | null,
    }));
    const [displayTransactions, inventoryProjectionIssues] = await Promise.all([
      withInventoryDisplay(transactions), loadInventoryProjectionIssues(monthStart, nextMonth),
    ]);
    const entries = buildLedgerEntries(displayTransactions, candidates, partnerDefaultsByParty, mealCandidateSources);
    return ledgerJson({ ok: true, month, fundsView: { month, mode: fundsViewMode, asOf: fundsViewMode === "live" ? now.toISOString() : monthEndCutoffAt, businessDateExclusive: fundsViewMode === "live" ? null : nextMonth }, inventoryProjectionIssues, summary: { income: recognizedIncome, receivedIncome, expense, operatingProfit: recognizedIncome - expense, paidExpense, cardGrossSales, reconciledCardGross, unreconciledCardGross, actualCardDeposits, unsettledCardGross }, accounts, categories: categoriesResult.data ?? [], parties: partiesResult.data ?? [], partners, transactions: displayTransactions, entries });
  } catch (error) {
    console.error("[LEDGER_GET_FAILED]", error);
    return ledgerJson({ ok: false, code: "LEDGER_LOAD_FAILED" }, 500);
  }
}

async function loadMonthTransactions(start: string, end: string) {
  const rows: TransactionRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseServer.from("ledger_transactions")
      .select(TRANSACTION_SELECT)
      .eq("status", "confirmed").gte("business_date", start).lt("business_date", end)
      .order("business_date", { ascending: false }).order("id", { ascending: false }).range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as TransactionRow[]));
    if ((data?.length ?? 0) < pageSize) break;
  }

  // A meal can be adjusted after a calendar-month boundary while its original
  // recognition month is still open. Fetch only corrections linked to meal
  // originals in this page set; never scan unrelated correction history.
  const mealOriginalIds = rows
    .filter((row) => row.source_type === "attendance_meal_daily_candidate")
    .map((row) => Number(row.id));
  const linked: TransactionRow[] = [];
  const idChunkSize = 200;
  for (let offset = 0; offset < mealOriginalIds.length; offset += idChunkSize) {
    const ids = mealOriginalIds.slice(offset, offset + idChunkSize);
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabaseServer.from("ledger_transactions")
        .select(TRANSACTION_SELECT)
        .eq("status", "confirmed")
        .eq("source_type", "ledger_correction")
        .eq("source_snapshot->>adjustmentType", "employee_meal")
        .in("correction_of_id", ids)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      linked.push(...((data ?? []) as TransactionRow[]));
      if ((data?.length ?? 0) < pageSize) break;
    }
  }
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  for (const row of linked) byId.set(Number(row.id), row);
  return [...byId.values()];
}

async function loadPendingInventoryCandidates(start: string, end: string) {
  const rows: CandidateRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseServer.from("ledger_candidates")
      .select("id,business_date,proposed_amount,proposed_category_id,proposed_party_id,source_snapshot,source_fingerprint,category:ledger_categories(name),party:ledger_parties(name)")
      .eq("candidate_type", "inventory_purchase").eq("status", "pending")
      .gte("business_date", start).lt("business_date", end)
      .order("business_date", { ascending: false }).order("id", { ascending: false }).range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as CandidateRow[]));
    if ((data?.length ?? 0) < pageSize) return rows;
  }
}

export async function POST(request: Request) {
  const auth = await requireLedgerActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = await request.json().catch(() => null) as Record<string,unknown> | null;
  if (!body) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  const allowed = new Set(["type","occurredAt","recognitionMonth","amount","categoryId","partyId","fromAccountId","toAccountId","memo","reason","sourceKey"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || !TYPES.has(String(body.type))) return ledgerJson({ ok: false, code: "INVALID_BODY" }, 400);
  try {
    const { data, error } = await supabaseServer.rpc("ledger_create_manual_transaction_v1", {
      p_type: body.type, p_occurred_at: body.occurredAt, p_recognition_month: body.recognitionMonth || null,
      p_amount: body.amount, p_category_id: body.categoryId || null, p_party_id: body.partyId || null,
      p_from_account_id: body.fromAccountId || null, p_to_account_id: body.toAccountId || null,
      p_memo: body.memo || null, p_reason: body.reason || null, p_actor_user_id: auth.actor.id, p_source_key: body.sourceKey || null,
    });
    if (error) throw error;
    const result = data as { status?: string };
    if (result.status !== "created") {
      const conflict = result.status === "duplicate_source";
      return ledgerJson({ ok: false, code: String(result.status ?? "LEDGER_CREATE_FAILED").toUpperCase() }, conflict ? 409 : result.status === "forbidden" ? 403 : 400);
    }
    return ledgerJson({ ok: true, result }, 201);
  } catch (error) {
    console.error("[LEDGER_POST_FAILED]", error);
    return ledgerJson({ ok: false, code: "LEDGER_CREATE_FAILED" }, 500);
  }
}
