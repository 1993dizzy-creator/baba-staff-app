// @ts-expect-error Node's local strip-types test runner requires the extension.
import { payableDisplayAsOf } from "./payables.ts";

export type LedgerEntryItem = {
  candidateId?: number;
  transactionId?: number;
  name: string;
  nameVi?: string | null;
  inventoryCategory?: string | null;
  inventoryCategoryVi?: string | null;
  unit?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  amount: number;
  categoryId?: number | null;
  categoryName?: string | null;
  paymentMode?: "immediate" | "payable";
  fundAccountId?: number | null;
  dueDate?: string | null;
  payableStatus?: string | null;
  paidAmount?: number;
  settlementPaidAmount?: number;
  remainingAmount?: number;
  settlementStatus?: "unpaid" | "partial" | "paid";
  memo?: string | null;
  sourceUpdatedAt?: string | null;
  displayTime?: string | null;
  sortTimestamp?: number;
};

export type LedgerEntry = {
  id: string;
  businessDate: string;
  // User-facing ledger bucket; accounting participation is tracked separately.
  direction: "income" | "expense" | "transfer";
  participatesInProfit?: boolean;
  origin: "auto" | "manual";
  status: "confirmed" | "pending";
  isSystemAdjustment: boolean;
  title: string;
  subtitle: string;
  memo?: string | null;
  amount: number;
  // Signed multiplier (+1/-1) for netting corrections/reversals into visible
  // date-group subtotals without changing the displayed row amount.
  economicEffectSign: number;
  displayTime: string | null;
  sortTimestamp: number;
  inventoryStartAt?: string | null;
  inventoryEndAt?: string | null;
  originalAmount?: number;
  adjustmentAmount?: number;
  effectiveAmount?: number;
  adjustmentCount?: number;
  sourceAmount?: number;
  requiresCorrection?: boolean;
  accountName: string | null;
  remainingAmount?: number;
  settlementStatus?: "unpaid" | "partial" | "paid";
  categoryName: string | null;
  transactionId: number | null;
  drilldown: "inventory" | "pos" | "payroll" | "meal" | "generic";
  defaultResolution?: "immediate" | "payable";
  defaultFundAccountId?: number | null;
  partyId?: number | null;
  systemDisplay?:
    | { kind: "pos"; paymentBucket: "cash" | "transfer" | "card" | "other"; receiptCount: number }
    | { kind: "meal"; employeeCount: number }
    | { kind: "inventory"; itemCount: number; partyMissing: boolean; needsConfirmation: boolean }
    | { kind: "rent" };
  items: LedgerEntryItem[];
};

export type TransactionRow = {
  display_snapshot?: Record<string, unknown> | null;
  id: number | string; type: string; status?: string; business_date: string; amount: number | string;
  occurred_at?: string | null;
  recognition_month?: string | null;
  party_id?: number | string | null;
  correction_of_id?: number | string | null;
  economic_effect_sign?: number | string | null; source_type: string; source_key?: string | null;
  memo?: string | null; category?: { id?: number | string; name?: string | null } | null; party?: { name?: string | null } | null;
  source_snapshot?: Record<string, unknown> | null;
  movements?: Array<{ amount?: number | string; fund_account?: { id?: number | string; code?: string | null; display_name?: string | null } | null }>;
  payable?: { id?: number|string; original_amount?:number|string; due_date?:string|null; status?:string|null; allocations?:Array<{allocated_amount:number|string;payment?:{business_date:string;status:string;movements?:Array<{amount?:number|string;fund_account?:{id?:number|string;code?:string|null;display_name?:string|null}|null}>}|null}> }|null;
};

export type CandidateRow = {
  id: number | string; business_date: string; proposed_amount: number | string;
  proposed_category_id?: number | string | null; proposed_party_id?: number | string | null;
  source_snapshot?: Record<string, unknown> | null;
  category?: { name?: string | null } | null; party?: { name?: string | null } | null;
};

export type PartnerLedgerDefault = {
  paymentMode: "immediate" | "postpaid";
  defaultFundAccountId: number | null;
  defaultFundAccountName: string | null;
};

export type MealCandidateSource = {
  resolvedTransactionId: number;
  sourceSnapshot: Record<string, unknown> | null;
  sourceDriftSnapshot: Record<string, unknown> | null;
};

// Types that can ever carry a recognition_month per the DB's own
// ledger_transaction_recognition_policy check constraint — i.e. types that
// represent a real profit/loss event rather than a pure fund movement.
const PROFIT_TYPES = new Set(["income", "expense", "sales", "expense_recognition"]);

function isSystemAdjustmentTransaction(row: TransactionRow) {
  if (row.source_key === "legacy-sheet-small-diff:2026-08") return false;
  return row.source_type === "ledger_correction" ||
    row.type === "balance_adjustment" ||
    /reversal|technical_adjustment/.test(row.source_type) ||
    /월말\s*잔액\s*맞춤|상세\s*전환\s*상쇄|기술적\s*보정/.test(row.memo ?? "");
}

export function accountFromPaymentNote(note: unknown) {
  if(typeof note!=="string")return null;
  const names=new Set<string>();
  if(/현금|tiền\s*mặt/i.test(note))names.add("매장 현금");
  if(/tk\s*\(\s*cho\s*\)/i.test(note))names.add("개인(Cho)");
  if(/tài\s*khoản/i.test(note))names.add("개인(Vương)");
  if(/법인|pháp\s*nhân/i.test(note))names.add("BABA 법인계좌");
  return names.size>1?"복수계정":names.values().next().value??null;
}

function transactionPaymentDisplay(row:TransactionRow,month:string){
  if(!row.payable)return null;
  return payableDisplayAsOf(row.payable.original_amount??row.amount,row.payable.allocations??[],month);
}

export function entryDisplaySubtotal(entry: Pick<LedgerEntry, "direction" | "amount" | "economicEffectSign">) {
  const signedAmount = entry.amount * entry.economicEffectSign;
  return {
    income: entry.direction === "income" ? signedAmount : 0,
    expense: entry.direction === "expense" ? signedAmount : 0,
  };
}

function displayMemo(memo: string | null | undefined) {
  return (memo ?? "").replace(/^\s*\d{1,2}월\s*시트\s*row\s*\d+\s*[·:—-]?\s*/i, "").trim();
}

function specialTransactionDisplay(row: TransactionRow) {
  const memo = displayMemo(row.memo);
  if (row.type === "investment" && row.source_type === "owner_investment") {
    const investor = memo.match(/([\p{L}\p{N}]+)\s*투자금/u)?.[1];
    return { title: investor ? `${investor} 투자금` : "투자금", subtitle: "사업 투자금" };
  }
  if (row.type === "prepaid_expense_payment") {
    const planName = String(row.source_snapshot?.planName ?? "");
    const rent = /임대료|월세/.test(`${memo} ${planName}`);
    const annual = /1년|12개월|연간/.test(memo);
    return {
      title: rent ? (annual ? "1년치 임대료 선지급" : "임대료 선지급") : memo || "비용 선지급",
      subtitle: rent ? "임대료 선지급 · 현금 지출" : "비용 선지급 · 현금 지출",
    };
  }
  return null;
}

const value = (input: unknown) => Number(input ?? 0);
const vietnamTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Ho_Chi_Minh",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function transactionTime(row: TransactionRow) {
  if (row.source_type === "attendance_meal_daily_candidate") {
    return {
      displayTime: "18:00",
      sortTimestamp: Date.parse(`${row.business_date}T18:00:00+07:00`),
    };
  }
  const sortTimestamp = Date.parse(row.occurred_at ?? "");
  if (!Number.isFinite(sortTimestamp)) {
    return { displayTime: null, sortTimestamp: 0 };
  }
  return {
    displayTime: vietnamTimeFormatter.format(new Date(sortTimestamp)),
    sortTimestamp,
  };
}

function timestampTime(input: unknown) {
  const sortTimestamp = Date.parse(typeof input === "string" ? input : "");
  if (!Number.isFinite(sortTimestamp)) {
    return { displayTime: null, sortTimestamp: 0 };
  }
  return {
    displayTime: vietnamTimeFormatter.format(new Date(sortTimestamp)),
    sortTimestamp,
  };
}

function inventoryTime(row: CandidateRow | TransactionRow) {
  const sourceUpdatedAt = row.source_snapshot?.inventory_log_created_at;
  const sourceTime = timestampTime(sourceUpdatedAt);
  if (sourceTime.sortTimestamp > 0) {
    return {
      ...sourceTime,
      sourceUpdatedAt: String(sourceUpdatedAt),
    };
  }
  if (!Object.hasOwn(row, "proposed_amount")) {
    return {
      ...timestampTime((row as TransactionRow).occurred_at),
      sourceUpdatedAt: null,
    };
  }
  return { displayTime: null, sortTimestamp: 0, sourceUpdatedAt: null };
}

function updateInventoryGroupTime(group: LedgerEntry, item: LedgerEntryItem) {
  const itemTimestamp = item.sortTimestamp ?? 0;
  if (itemTimestamp <= 0) return;
  const currentStart = Date.parse(group.inventoryStartAt ?? "");
  const currentEnd = Date.parse(group.inventoryEndAt ?? "");
  const startTimestamp = Number.isFinite(currentStart)
    ? Math.min(currentStart, itemTimestamp)
    : itemTimestamp;
  const endTimestamp = Number.isFinite(currentEnd)
    ? Math.max(currentEnd, itemTimestamp)
    : itemTimestamp;
  const startTime = vietnamTimeFormatter.format(new Date(startTimestamp));
  const endTime = vietnamTimeFormatter.format(new Date(endTimestamp));
  group.inventoryStartAt = new Date(startTimestamp).toISOString();
  group.inventoryEndAt = new Date(endTimestamp).toISOString();
  group.displayTime = startTime === endTime ? startTime : `${startTime} ~ ${endTime}`;
  // 정렬 대표 시간은 묶음의 최초 발생 시각을 기준으로 한다 (표시 범위는 start~end 그대로 유지).
  group.sortTimestamp = startTimestamp;
}

function inventorySupplierName(row: CandidateRow | TransactionRow) {
  return row.party?.name?.trim() || String(row.source_snapshot?.supplier ?? "").trim();
}

function inventoryPartyIdentity(partyId: number | null, supplierName: string) {
  if (partyId !== null) return `party:${partyId}`;
  const normalizedSupplier = supplierName.trim().toLocaleLowerCase();
  return normalizedSupplier ? `supplier:${normalizedSupplier}` : "supplier:none";
}

// inventory 품목을 "시간 있는 항목은 오름차순, 시간 없는 항목은 뒤"로 정렬한다.
// Array.prototype.sort는 안정 정렬이므로 동일 시간(또는 둘 다 시간 없음)끼리는 기존 순서가 유지된다.
function compareItemsByEarliestTimeFirst(a: LedgerEntryItem, b: LedgerEntryItem) {
  const aHasTime = (a.sortTimestamp ?? 0) > 0;
  const bHasTime = (b.sortTimestamp ?? 0) > 0;
  if (aHasTime && bHasTime) return (a.sortTimestamp ?? 0) - (b.sortTimestamp ?? 0);
  if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
  return 0;
}

const inventoryItem = (row: CandidateRow | TransactionRow, viewMonth?:string): LedgerEntryItem => {
  const snapshot = row.source_snapshot ?? {};
  const display = (row as TransactionRow).display_snapshot ?? snapshot;
  const time = inventoryTime(row);
  return {
    ...(Object.hasOwn(row, "proposed_amount") ? { candidateId: value((row as CandidateRow).id) } : { transactionId: value(row.id) }),
    name: String(display.item_name ?? display.item_name_vi ?? "품목"),
    nameVi: display.item_name_vi == null ? null : String(display.item_name_vi),
    inventoryCategory: display.category == null ? null : String(display.category),
    inventoryCategoryVi: display.category_vi == null ? null : String(display.category_vi),
    unit: display.unit == null ? null : String(display.unit),
    quantity: snapshot.change_quantity == null ? null : value(snapshot.change_quantity),
    unitPrice: snapshot.purchase_price == null ? null : value(snapshot.purchase_price),
    amount: Object.hasOwn(row, "proposed_amount") ? value((row as CandidateRow).proposed_amount) : value((row as TransactionRow).amount),
    categoryId: Object.hasOwn(row, "proposed_category_id") ? ((row as CandidateRow).proposed_category_id == null ? null : value((row as CandidateRow).proposed_category_id)) : ((row as TransactionRow).category?.id == null ? null : value((row as TransactionRow).category?.id)),
    categoryName: row.category?.name ?? (snapshot.category ? String(snapshot.category) : null),
    ...time,
    ...(!Object.hasOwn(row, "proposed_amount") ? {
      paymentMode: (row as TransactionRow).payable ? "payable" as const : "immediate" as const,
      fundAccountId: (row as TransactionRow).movements?.find(item=>value(item.amount)<0)?.fund_account?.id == null ? null : value((row as TransactionRow).movements?.find(item=>value(item.amount)<0)?.fund_account?.id),
      dueDate: (row as TransactionRow).payable?.due_date ?? null,
      payableStatus: (row as TransactionRow).payable?.status ?? null,
      paidAmount: ((row as TransactionRow).payable?.allocations??[]).reduce((sum,item)=>sum+value(item.allocated_amount),0),
      settlementPaidAmount: viewMonth ? transactionPaymentDisplay(row as TransactionRow,viewMonth)?.paidAmount ?? 0 : undefined,
      remainingAmount: viewMonth ? transactionPaymentDisplay(row as TransactionRow,viewMonth)?.remainingAmount : undefined,
      settlementStatus: viewMonth ? transactionPaymentDisplay(row as TransactionRow,viewMonth)?.status : undefined,
      memo: (row as TransactionRow).memo ?? null,
    } : {}),
  };
};

function paymentBucket(sourceKey: string | null | undefined) {
  const bucket = sourceKey?.split(":").at(-1);
  return bucket === "cash" || bucket === "transfer" || bucket === "card" ? bucket : "other";
}

export function buildLedgerEntries(
  transactions: readonly TransactionRow[],
  candidates: readonly CandidateRow[],
  partnerDefaultsByParty: ReadonlyMap<number, PartnerLedgerDefault>,
  mealCandidateSources: readonly MealCandidateSource[] = [],
  viewMonth = transactions[0]?.business_date.slice(0,7) ?? "",
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  const inventoryGroups = new Map<string, LedgerEntry>();
  const mealAdjustmentsByOriginal = new Map<number, TransactionRow[]>();
  const mealOriginalIds = new Set(transactions
    .filter((row) => row.source_type === "attendance_meal_daily_candidate")
    .map((row) => value(row.id)));
  const mealSourceByTransaction = new Map(
    mealCandidateSources.map((candidate) => [candidate.resolvedTransactionId, candidate]),
  );
  for (const row of transactions) {
    if (
      row.source_type !== "ledger_correction" || row.correction_of_id == null ||
      (row.status != null && row.status !== "confirmed") ||
      !mealOriginalIds.has(value(row.correction_of_id))
    ) continue;
    const originalId = value(row.correction_of_id);
    const linked = mealAdjustmentsByOriginal.get(originalId) ?? [];
    linked.push(row);
    mealAdjustmentsByOriginal.set(originalId, linked);
  }
  const reversedInventoryIds = new Set(
    transactions
      .filter(row => row.source_type === "inventory_purchase_reversal" && row.correction_of_id != null)
      .map(row => value(row.correction_of_id)),
  );

  for (const row of transactions) {
    if (row.type === "opening") continue;
    if (
      row.source_type === "ledger_correction" &&
      row.correction_of_id != null &&
      mealOriginalIds.has(value(row.correction_of_id))
    ) continue;
    if (row.source_type === "inventory_purchase_reversal") continue;
    if (row.source_type === "inventory_purchase_candidate" || row.source_type === "inventory_purchase_rebook") {
      if (reversedInventoryIds.has(value(row.id))) continue;
    }
    const transactionId = value(row.id);
    const amount = value(row.amount);
    // Recognition eligibility follows the DB's profit types. The visible
    // direction also includes prepaid cash expense, without recognizing it.
    const participatesInProfit = PROFIT_TYPES.has(row.type);
    const expense = participatesInProfit && (row.type === "expense" || row.type === "expense_recognition");
    const direction = row.type === "prepaid_expense_payment" ? "expense" : !participatesInProfit ? "transfer" : expense ? "expense" : "income";
    const economicEffectSign = value(row.economic_effect_sign) || 1;
    const movement = row.movements?.find(item => direction === "income" ? value(item.amount) > 0 : value(item.amount) < 0) ?? row.movements?.[0];
    const paymentDisplay = row.payable && viewMonth ? transactionPaymentDisplay(row,viewMonth) : null;
    const accountName = movement
      ? movement.fund_account?.display_name ?? "계정 확인 필요"
      : paymentDisplay
        ? paymentDisplay.status==="unpaid" ? "미지급" : paymentDisplay.accountName ?? "지급계정 확인 필요"
        : accountFromPaymentNote(row.source_snapshot?.paymentNote);
    const automatic = row.source_type !== "manual";
    const time = transactionTime(row);

    if (row.source_type === "inventory_purchase_candidate" || row.source_type === "inventory_purchase_rebook") {
      const partyId = row.party_id == null ? null : value(row.party_id);
      const partyMissing = !row.party?.name?.trim();
      const partyName = inventorySupplierName(row);
      const partyIdentity = inventoryPartyIdentity(partyId, partyName);
      const key = `confirmed-inventory:${row.business_date}:${partyIdentity}:${accountName ?? "payable"}:${paymentDisplay?.status??"immediate"}`;
      const group = inventoryGroups.get(key) ?? {
        id: key, businessDate: row.business_date, direction: "expense", origin: "auto", status: "confirmed", isSystemAdjustment: false,
        title: partyName, subtitle: "", amount: 0, economicEffectSign: 1, displayTime: null, sortTimestamp: 0,
        inventoryStartAt: null, inventoryEndAt: null, accountName: accountName ?? "미지급",
        categoryName: row.category?.name ?? null, transactionId, drilldown: "inventory",
        settlementStatus: paymentDisplay?.status, remainingAmount: 0,
        systemDisplay: { kind: "inventory", itemCount: 0, partyMissing, needsConfirmation: false }, items: [],
      } satisfies LedgerEntry;
      const item = inventoryItem(row,viewMonth);
      group.amount += amount;
      group.remainingAmount = (group.remainingAmount??0)+(paymentDisplay?.remainingAmount??0);
      group.items.push(item);
      updateInventoryGroupTime(group, item);
      if (group.systemDisplay?.kind === "inventory") group.systemDisplay.itemCount = group.items.length;
      inventoryGroups.set(key, group);
      continue;
    }

    if (row.source_type === "attendance_meal_daily_candidate") {
      const linked = mealAdjustmentsByOriginal.get(transactionId) ?? [];
      const originalAmount = amount * value(row.economic_effect_sign ?? 1);
      const adjustmentAmount = linked.reduce(
        (sum, adjustment) =>
          sum + value(adjustment.amount) * value(adjustment.economic_effect_sign ?? 1),
        0,
      );
      const effectiveAmount = originalAmount + adjustmentAmount;
      const candidateSource = mealSourceByTransaction.get(transactionId);
      const latestSourceSnapshot = candidateSource?.sourceDriftSnapshot ??
        candidateSource?.sourceSnapshot ?? row.source_snapshot ?? {};
      const employeeCount = value(latestSourceSnapshot.employee_count);
      const sourceAmount = value(latestSourceSnapshot.total_amount);
      const requiresCorrection = candidateSource?.sourceDriftSnapshot != null &&
        sourceAmount !== effectiveAmount;
      entries.push({
        id: `transaction:${transactionId}`,
        businessDate: row.business_date,
        direction: "expense",
        origin: "auto",
        status: "confirmed",
        isSystemAdjustment: false,
        title: "",
        subtitle: "",
        amount: effectiveAmount,
        economicEffectSign: 1,
        ...time,
        originalAmount,
        adjustmentAmount,
        effectiveAmount,
        adjustmentCount: linked.length,
        sourceAmount,
        requiresCorrection,
        accountName,
        categoryName: row.category?.name ?? null,
        transactionId,
        drilldown: "meal",
        systemDisplay: { kind: "meal", employeeCount },
        items: [],
      });
      continue;
    }

    const snapshot = row.source_snapshot ?? {};
    const pos = row.source_type === "pos_sales_daily_payment";
    const posPaymentBucket = paymentBucket(row.source_key);
    const rent = row.source_type === "recurring_expense" &&
      (row.category?.name === "임대료" || snapshot.planName === "매장 임대료");
    const payroll = row.source_type.includes("payroll");
    const specialDisplay = specialTransactionDisplay(row);
    entries.push({
      id: `transaction:${transactionId}`, businessDate: row.business_date, direction, participatesInProfit,
      origin: automatic ? "auto" : "manual", status: "confirmed", isSystemAdjustment: isSystemAdjustmentTransaction(row),
      title: specialDisplay?.title ?? (pos || rent ? "" : payroll ? "급여 · 인건비" : displayMemo(row.memo) || row.party?.name || row.category?.name || "장부 거래"),
      subtitle: specialDisplay?.subtitle ?? (pos || rent ? "" : row.category?.name ?? (automatic ? "자동 장부" : "수동 입력")),
      memo: row.memo ?? null,
      amount, economicEffectSign, ...time, accountName, settlementStatus: paymentDisplay?.status, remainingAmount: paymentDisplay?.remainingAmount, categoryName: row.category?.name ?? null, transactionId,
      drilldown: pos ? "pos" : payroll ? "payroll" : "generic",
      ...(pos ? { systemDisplay: { kind: "pos" as const, paymentBucket: posPaymentBucket, receiptCount: value(snapshot.receiptCount) } } : {}),
      ...(rent ? { systemDisplay: { kind: "rent" as const } } : {}),
      items: [],
    });
  }

  for (const row of candidates) {
    const partyId = row.proposed_party_id == null ? null : value(row.proposed_party_id);
    const defaults = partyId === null ? undefined : partnerDefaultsByParty.get(partyId);
    const resolution = defaults?.paymentMode === "postpaid" ? "payable" : "immediate";
    const partyMissing = !row.party?.name?.trim();
    const partyName = inventorySupplierName(row);
    const partyIdentity = inventoryPartyIdentity(partyId, partyName);
    const accountName = resolution === "payable" ? "미지급" : defaults?.defaultFundAccountName ?? "결제계정 확인 필요";
    const key = `pending-inventory:${row.business_date}:${partyIdentity}:${resolution}:${defaults?.defaultFundAccountId ?? "none"}`;
    const group = inventoryGroups.get(key) ?? {
      id: key, businessDate: row.business_date, direction: "expense", origin: "auto", status: "pending", isSystemAdjustment: false,
      title: partyName, subtitle: "", amount: 0, economicEffectSign: 1,
      displayTime: null, sortTimestamp: 0, inventoryStartAt: null, inventoryEndAt: null, accountName,
      categoryName: row.category?.name ?? null, transactionId: null, drilldown: "inventory",
      defaultResolution: resolution, defaultFundAccountId: defaults?.defaultFundAccountId ?? null,
      partyId, systemDisplay: { kind: "inventory", itemCount: 0, partyMissing, needsConfirmation: true }, items: [],
    } satisfies LedgerEntry;
    const item = inventoryItem(row);
    group.amount += value(row.proposed_amount);
    group.items.push(item);
    updateInventoryGroupTime(group, item);
    if (group.systemDisplay?.kind === "inventory") group.systemDisplay.itemCount = group.items.length;
    inventoryGroups.set(key, group);
  }

  for (const group of inventoryGroups.values()) {
    group.items.sort(compareItemsByEarliestTimeFirst);
  }
  entries.push(...inventoryGroups.values());
  return entries.sort((a, b) =>
    b.businessDate.localeCompare(a.businessDate) ||
    b.sortTimestamp - a.sortTimestamp ||
    Number(b.status === "pending") - Number(a.status === "pending") ||
    a.id.localeCompare(b.id)
  );
}
