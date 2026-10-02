import type { PaymentMode } from "@/lib/partners/policy";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { payableDisplayAsOf } from "./payables.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { ledgerPayrollAdvanceRequestId, PAYROLL_ADVANCE_REVERSAL_SOURCE_TYPE } from "./payroll-advance.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { shortLedgerAccountName } from "./entry-display-account.ts";

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
  fundFlow?: "inflow" | "outflow" | "none";
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
  // Display identity only: payroll/labor rows (advances may have no category).
  employeeCost?: boolean;
  payrollPayment?: boolean;
  // Display identity only: an actual supplier payable payment (payable_payment);
  // direction stays "transfer" so the cost is never counted twice.
  paymentTransaction?: boolean;
  editableManualDisplay?: boolean;
  // Advance created by the ledger 👥 가불 path (cancellable from the ledger);
  // cancelled once its append-only reversal exists. Historical advances: unset.
  ledgerPayrollAdvance?: { requestId: string; cancelled: boolean };
  // Display identity only: a user-facing adjustment shown as [조정] — a manual
  // balance_adjustment, or an explicit payment/settlement difference. Accounting
  // direction and amounts are unchanged.
  userAdjustment?: "balance" | "paymentDifference";
  // Display identity only: an actual account-to-account transfer transaction.
  transferTransaction?: boolean;
  // Display-only row derived from a payable payment's linked difference (see
  // withPaymentDifferenceAdjustments); never part of 전체 or its subtotal.
  paymentDifference?: { paymentEntryId: string; partyName: string };
  categoryName: string | null;
  transactionId: number | null;
  drilldown: "inventory" | "pos" | "payroll" | "meal" | "generic";
  defaultResolution?: "immediate" | "payable" | "verification_pending";
  defaultFundAccountId?: number | null;
  partyId?: number | null;
  systemDisplay?:
    | { kind: "pos"; paymentBucket: "cash" | "transfer" | "card" | "other"; receiptCount: number }
    | { kind: "meal"; employeeCount: number }
    | { kind: "inventory"; itemCount: number; partyMissing: boolean; needsConfirmation: boolean }
    | { kind: "rent" }
    | { kind: "payablePayment"; partyName: string; prepaid: boolean; actualPaidAmount?: number; paymentDifferenceAmount?: number }
    | { kind: "accountTransfer"; fromAccountName: string; toAccountName: string }
    | { kind: "investment"; cashFlow: "inflow" | "outflow" | "none" }
    | { kind: "cardSettlementDeposit" }
    | { kind: "cardSettlementDifference"; matchedGrossAmount: number | null; depositAmount: number | null; differenceAmount: number | null }
    | { kind: "cardFeeMonthClose" }
    // Informational reserve history row (ledger_reserve_entries). Never a
    // ledger_transaction: no movement, no P&L, no daily income/expense subtotal.
    | { kind: "reserve"; reserveEntryId: number; reservePlanId: number; reserveName: string; entryType: ReserveEntryType; signedAmount: number };
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
  paymentMode: PaymentMode;
  defaultFundAccountId: number | null;
  defaultFundAccountName: string | null;
};

export type MealCandidateSource = {
  resolvedTransactionId: number;
  sourceSnapshot: Record<string, unknown> | null;
  sourceDriftSnapshot: Record<string, unknown> | null;
  sourceDriftFingerprint?: string | null;
};

// Types that can ever carry a recognition_month per the DB's own
// ledger_transaction_recognition_policy check constraint — i.e. types that
// represent a real profit/loss event rather than a pure fund movement.
const PROFIT_TYPES = new Set(["income", "expense", "sales", "expense_recognition"]);
const EMPLOYEE_COST_CATEGORIES = new Set(["급여/인건비", "인건비", "급여"]);

function isEmployeeCostTransaction(row: TransactionRow) {
  return row.type === "payroll_payment" ||
    row.source_type.includes("payroll") ||
    /^payroll-/.test(row.source_key ?? "") ||
    EMPLOYEE_COST_CATEGORIES.has(row.category?.name ?? "");
}

// User-facing adjustments only: never corrections, reversals or technical rows.
// Explicit sheet differences are created with a sheet-adjustment:* source key.
function userAdjustmentKind(row: TransactionRow): LedgerEntry["userAdjustment"] {
  if (row.source_type !== "manual" || row.correction_of_id != null) return undefined;
  if (row.type === "balance_adjustment") return "balance";
  if ((row.type === "expense" || row.type === "income") && /^sheet-adjustment:/.test(row.source_key ?? "")) return "paymentDifference";
  return undefined;
}

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

export function isPayrollPaymentOutflow(entry: Pick<LedgerEntry, "payrollPayment" | "fundFlow">) {
  return entry.payrollPayment === true && entry.fundFlow === "outflow";
}

const CARD_SETTLEMENT_KINDS = new Set(["cardSettlementDeposit", "cardSettlementDifference", "cardFeeMonthClose"]);

// Card settlement rows (actual deposit, valid legacy difference, month-close
// fee) share the [카드] display identity. POS card sales are sales, not this.
export function isCardSettlementEntry(entry: Pick<LedgerEntry, "systemDisplay">) {
  return CARD_SETTLEMENT_KINDS.has(entry.systemDisplay?.kind ?? "");
}

export function isReserveLedgerEntry(entry: Pick<LedgerEntry, "systemDisplay">) {
  return entry.systemDisplay?.kind === "reserve";
}

export function entryMatchesExpenseFilter(entry: Pick<LedgerEntry, "direction" | "payrollPayment" | "fundFlow">) {
  return entry.direction === "expense" || isPayrollPaymentOutflow(entry);
}

export function entryDisplaySubtotal(entry: Pick<LedgerEntry, "direction" | "amount" | "economicEffectSign" | "systemDisplay" | "payrollPayment" | "fundFlow" | "paymentDifference">) {
  // Informational rows: reserve history and derived payment-difference rows
  // (their expense is already in the payment row's subtotal).
  if (isReserveLedgerEntry(entry) || entry.paymentDifference) return { income: 0, expense: 0 };
  const signedAmount = entry.amount * entry.economicEffectSign;
  return {
    income: entry.direction === "income" ? signedAmount : 0,
    expense: (entry.direction === "expense" ? signedAmount : 0) +
      (isPayrollPaymentOutflow(entry) ? entry.amount : 0) +
      (entry.systemDisplay?.kind === "payablePayment" ? entry.systemDisplay.paymentDifferenceAmount ?? 0 : 0),
  };
}

function transactionFundFlow(row: TransactionRow): "inflow" | "outflow" | "none" {
  const net = (row.movements ?? []).reduce((sum, movement) => sum + value(movement.amount), 0);
  return net > 0 ? "inflow" : net < 0 ? "outflow" : "none";
}

function accountTransferDisplay(row: TransactionRow) {
  if (row.type !== "transfer" || row.status !== "confirmed" || row.movements?.length !== 2) return null;
  const from = row.movements.find(movement => value(movement.amount) < 0);
  const to = row.movements.find(movement => value(movement.amount) > 0);
  if (!from || !to || -value(from.amount) !== value(to.amount)) return null;
  const fromAccountName = from.fund_account?.display_name?.trim();
  const toAccountName = to.fund_account?.display_name?.trim();
  return fromAccountName && toAccountName
    ? { kind: "accountTransfer" as const, fromAccountName, toAccountName }
    : null;
}

function accountTransferTitle(row: TransactionRow, transfer: NonNullable<ReturnType<typeof accountTransferDisplay>>) {
  const memo = displayMemo(row.memo);
  const segments = memo.split(/\s+·\s+/);
  if (segments.length < 2) return conciseTransactionTitle(row);
  const route = segments.at(-1)?.match(/^(.+?)\s*→\s*(.+?)\s+([\d,]+)\s*₫$/u);
  if (!route || route[1].trim() !== shortLedgerAccountName(transfer.fromAccountName, "ko") ||
      route[2].trim() !== shortLedgerAccountName(transfer.toAccountName, "ko") ||
      Number(route[3].replace(/,/g, "")) !== value(row.amount)) return conciseTransactionTitle(row);
  return segments.slice(0, -1).join(" · ").trim() || conciseTransactionTitle(row);
}

function investmentDisplayFlow(row: TransactionRow): "inflow" | "outflow" | "none" | null {
  const snapshot = row.source_snapshot ?? {};
  const ownerPayment = row.type === "owner_settlement_payment" || row.source_type === "owner_settlement_payment";
  const capitalRecovery = snapshot.settlementType === "capital_recovery" ||
    (snapshot.settlementType == null && Number(snapshot.recoveryPaid) > 0 && Number(snapshot.pureProfitPaid ?? 0) === 0);
  if (row.type !== "investment" && row.source_type !== "owner_investment" &&
      row.source_type !== "owner_investment_recovery" && !(ownerPayment && capitalRecovery)) return null;
  const movementFlow = transactionFundFlow(row);
  if (movementFlow !== "none") return movementFlow;
  if (ownerPayment || row.source_type === "owner_investment_recovery" ||
      snapshot.entryType === "recovery" || Number(row.amount) < 0) return "outflow";
  if (snapshot.entryType === "contribution" || Number(row.amount) > 0) return "inflow";
  return "none";
}

function displayMemo(memo: string | null | undefined) {
  return (memo ?? "").replace(/^\s*\d{1,2}월\s*시트\s*row\s*\d+\s*[·:—-]?\s*/i, "").trim();
}

function hasPrepaymentFlag(snapshot: Record<string, unknown> | null | undefined) {
  if (!snapshot) return false;
  if (snapshot.prepayment === true || snapshot.isPrepayment === true || snapshot.prepaid === true) return true;
  return [snapshot.paymentType, snapshot.paymentKind].some(value =>
    typeof value === "string" && /^(prepayment|prepaid)$/i.test(value.trim()),
  );
}

function conciseTransactionTitle(row: TransactionRow) {
  const memo = displayMemo(row.memo);
  if (!memo) return row.party?.name || row.category?.name || "장부 거래";

  const [, month, day] = row.business_date.match(/^\d{4}-(\d{2})-(\d{2})$/) ?? [];
  const datePrefix = month && day
    ? new RegExp(`^\\s*0?${Number(month)}\\s*[/.-]\\s*0?${Number(day)}\\s+`)
    : null;
  const hasBusinessDatePrefix = datePrefix?.test(memo) ?? false;
  const titleMemo = hasBusinessDatePrefix && datePrefix ? memo.replace(datePrefix, "").trim() : memo;

  const payrollAdvance = titleMemo.match(/^\s*([^·\n]{1,40}?\s+(?:급여\s*가불|ứng\s*lương))(?=\s*(?:[·,]|$))/i);
  if (payrollAdvance) return payrollAdvance[1].trim();

  // 임의의 사용자 메모는 보존한다. 영업일과 같은 날짜로 시작하고 뒤 절이
  // 계정/금액 반복임이 분명한 형식만 목록 제목에서 안전하게 덜어낸다.
  if (hasBusinessDatePrefix) {
    const segments = titleMemo.split(/\s+·\s+/);
    if (
      segments.length > 1 &&
      segments.slice(1).some(segment => /(?:₫|VND|동)\s*$/i.test(segment) || /(?:현금|cash|tiền\s*mặt)/i.test(segment))
    ) return segments[0].trim() || memo;
  }
  return memo;
}

function specialTransactionDisplay(row: TransactionRow) {
  const memo = displayMemo(row.memo);
  if (row.type === "payroll_payment" &&
    (row.source_snapshot?.paymentKind === "advance" || /^payroll-advance-payment:/.test(row.source_key ?? "") ||
      (row.source_type === "manual" && /(?:급여\s*가불|ứng\s*lương)/i.test(memo)))) {
    const employee = typeof row.source_snapshot?.employee === "string" ? row.source_snapshot.employee.trim() : "";
    const memoWithoutDate = memo.replace(/^\s*\d{1,2}\s*[/.-]\s*\d{1,2}\s+/, "");
    const memoEmployee = memoWithoutDate.match(/^(.+?)\s+(?:급여\s*가불|ứng\s*lương)/i)?.[1]?.trim();
    return { title: `${employee || memoEmployee || "직원"} 급여 가불`, subtitle: "" };
  }
  const investmentFlow = investmentDisplayFlow(row);
  if (investmentFlow !== null) {
    const investor = memo.match(/([\p{L}\p{N}]+)\s*투자금/u)?.[1] ||
      String(row.source_snapshot?.participantName ?? row.source_snapshot?.investorName ?? row.party?.name ?? "").trim();
    const name = investor ? `${investor} 투자금` : "투자금";
    return { title: investmentFlow === "outflow" ? `${name} 회수` : name, subtitle: "사업 투자금" };
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
  if (row.source_type === "pos_sales_daily_payment") {
    const syncedTime = timestampTime(row.source_snapshot?.syncedAt);
    if (syncedTime.sortTimestamp > 0) return syncedTime;
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

export function entryRequiresReview(entry: Pick<LedgerEntry, "status" | "requiresCorrection">) {
  return entry.status === "pending" || entry.requiresCorrection === true;
}

// POS daily rows describe a completed sync, so keep them after the day's
// operational transactions without changing either row's business date.
export function compareLedgerEntriesByDisplayTime(a: LedgerEntry, b: LedgerEntry) {
  const aPosClose = a.systemDisplay?.kind === "pos";
  const bPosClose = b.systemDisplay?.kind === "pos";
  return Number(aPosClose) - Number(bPosClose) ||
    a.sortTimestamp - b.sortTimestamp || a.id.localeCompare(b.id);
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
  const display = (row as TransactionRow).display_snapshot;
  const supplier = display && Object.hasOwn(display, "supplier")
    ? display.supplier : row.source_snapshot?.supplier;
  return row.party?.name?.trim() || String(supplier ?? "").trim();
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
  const cancelledPayrollAdvanceIds = new Set(
    transactions
      .filter(row => row.source_type === PAYROLL_ADVANCE_REVERSAL_SOURCE_TYPE && row.correction_of_id != null)
      .map(row => value(row.correction_of_id)),
  );
  const reversedInventoryIds = new Set(
    transactions
      .filter(row => row.source_type === "inventory_purchase_reversal" && row.correction_of_id != null)
      .map(row => value(row.correction_of_id)),
  );
  const transactionsById = new Map(transactions.map(row => [value(row.id), row]));
  const linkedPaymentDifferences = new Map<number, { actualPaidAmount: number; differenceAmount: number }>();
  const hiddenPaymentDifferenceIds = new Set<number>();
  for (const payment of transactions) {
    if (payment.type !== "payable_payment" || payment.status !== "confirmed") continue;
    const actual = Number(payment.display_snapshot?.actualPaidAmount);
    const differenceAmount = Number(payment.display_snapshot?.paymentDifferenceAmount);
    const linkedId = Number(payment.display_snapshot?.linkedDifferenceTransactionId);
    const difference = transactionsById.get(linkedId);
    if (!Number.isSafeInteger(linkedId) || !difference || difference.status !== "confirmed" ||
        difference.source_type !== "manual" || difference.type !== "expense" ||
        difference.business_date !== payment.business_date || difference.amount == null ||
        !Number.isFinite(differenceAmount) || differenceAmount <= 0 ||
        value(difference.amount) !== differenceAmount ||
        actual !== value(payment.amount) + differenceAmount) continue;
    linkedPaymentDifferences.set(value(payment.id), { actualPaidAmount: actual, differenceAmount });
    hiddenPaymentDifferenceIds.add(linkedId);
  }
  const manualCorrectionsByOriginal = new Map<number, TransactionRow[]>();
  for (const row of transactions) {
    if (row.correction_of_id == null || row.status !== "confirmed") continue;
    const originalId = value(row.correction_of_id);
    const linked = manualCorrectionsByOriginal.get(originalId) ?? [];
    linked.push(row);
    manualCorrectionsByOriginal.set(originalId, linked);
  }
  const fullyReversedManualIds = new Set<number>();
  const hiddenManualCorrectionIds = new Set<number>();
  for (const original of transactions) {
    if (original.source_type !== "manual" || original.status !== "confirmed" ||
        original.correction_of_id != null || Number(original.economic_effect_sign ?? 1) !== 1) continue;
    const linked = manualCorrectionsByOriginal.get(value(original.id)) ?? [];
    if (!linked.length || !linked.every(correction =>
      correction.source_type === "ledger_correction" &&
      correction.type === original.type &&
      Number(correction.economic_effect_sign) === -1
    )) continue;
    const reversedAmount = linked.reduce((sum, correction) => sum + value(correction.amount), 0);
    if (reversedAmount !== value(original.amount)) continue;
    fullyReversedManualIds.add(value(original.id));
    for (const correction of linked) hiddenManualCorrectionIds.add(value(correction.id));
  }

  for (const row of transactions) {
    if (row.type === "opening") continue;
    if (row.type === "expense_recognition" && row.source_type === "payroll_completed_batch") continue;
    if (fullyReversedManualIds.has(value(row.id)) || hiddenManualCorrectionIds.has(value(row.id)) ||
        hiddenPaymentDifferenceIds.has(value(row.id))) continue;
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
    const fundFlow = transactionFundFlow(row);
    const movement = row.movements?.find(item => direction === "income" ? value(item.amount) > 0 : value(item.amount) < 0) ?? row.movements?.[0];
    const paymentDisplay = row.payable && viewMonth ? transactionPaymentDisplay(row,viewMonth) : null;
    const accountName = movement
      ? movement.fund_account?.display_name ?? "계정 확인 필요"
      : paymentDisplay
        // Until fully paid the original stays 미지급; partial payers show on the payment rows.
        ? paymentDisplay.status!=="paid" ? "미지급" : paymentDisplay.accountName ?? "지급계정 확인 필요"
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
        categoryName: row.category?.name ?? null, transactionId, partyId, drilldown: "inventory",
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
      const originalSourceAmount = value(row.source_snapshot?.total_amount ??
        candidateSource?.sourceSnapshot?.total_amount ?? originalAmount);
      const driftFingerprint = candidateSource?.sourceDriftFingerprint;
      const driftReviewed = !!driftFingerprint &&
        row.display_snapshot?.mealSourceDriftReviewedFingerprint === driftFingerprint;
      const requiresCorrection = candidateSource?.sourceDriftSnapshot != null &&
        sourceAmount !== originalSourceAmount && sourceAmount !== effectiveAmount && !driftReviewed;
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
    const payablePayment = row.type === "payable_payment";
    const accountTransfer = accountTransferDisplay(row);
    const investmentFlow = investmentDisplayFlow(row);
    const linkedPaymentDifference = linkedPaymentDifferences.get(transactionId);
    const cardSettlementDeposit = row.type === "card_settlement_deposit";
    const cardSettlementDifference = row.source_type === "card_settlement_difference";
    const cardFeeMonthClose = row.source_type === "card_fee_month_close";
    const editableManualDisplay = row.source_type === "manual" &&
      ["income", "expense", "transfer", "payable_payment"].includes(row.type) && row.status === "confirmed" &&
      row.correction_of_id == null;
    const titleOverride = editableManualDisplay && typeof row.display_snapshot?.titleOverride === "string"
      ? row.display_snapshot.titleOverride.trim() : "";
    const snapshotNumber = (key: string) => {
      const number = Number(snapshot[key]);
      return snapshot[key] == null || !Number.isFinite(number) ? null : number;
    };
    entries.push({
      id: `transaction:${transactionId}`, businessDate: row.business_date, direction, participatesInProfit,
      origin: automatic ? "auto" : "manual", status: "confirmed", isSystemAdjustment: isSystemAdjustmentTransaction(row),
      title: titleOverride || (specialDisplay?.title ?? (pos || rent || payablePayment || cardSettlementDeposit ? "" : payroll ? "급여 · 인건비" : accountTransfer ? accountTransferTitle(row, accountTransfer) : conciseTransactionTitle(row))),
      subtitle: specialDisplay?.subtitle ?? (pos || rent ? "" : row.category?.name ?? (automatic ? "자동 장부" : "수동 입력")),
      memo: row.memo ?? null,
      amount, economicEffectSign, fundFlow, ...time, accountName, settlementStatus: paymentDisplay?.status, remainingAmount: paymentDisplay?.remainingAmount, categoryName: row.category?.name ?? null, transactionId,
      partyId: row.party_id == null ? null : value(row.party_id),
      employeeCost: isEmployeeCostTransaction(row),
      payrollPayment: row.type === "payroll_payment",
      paymentTransaction: payablePayment,
      editableManualDisplay,
      ...(userAdjustmentKind(row) ? { userAdjustment: userAdjustmentKind(row) } : {}),
      ...(row.type === "transfer" ? { transferTransaction: true } : {}),
      ...(ledgerPayrollAdvanceRequestId(row)
        ? { ledgerPayrollAdvance: { requestId: ledgerPayrollAdvanceRequestId(row)!, cancelled: cancelledPayrollAdvanceIds.has(transactionId) } }
        : {}),
      drilldown: pos ? "pos" : payroll ? "payroll" : "generic",
      ...(pos ? { systemDisplay: { kind: "pos" as const, paymentBucket: posPaymentBucket, receiptCount: value(snapshot.receiptCount) } } : {}),
      ...(rent ? { systemDisplay: { kind: "rent" as const } } : {}),
      ...(payablePayment ? { systemDisplay: { kind: "payablePayment" as const, partyName: row.party?.name?.trim() || "", prepaid: hasPrepaymentFlag(row.source_snapshot),
        ...(linkedPaymentDifference ? { actualPaidAmount: linkedPaymentDifference.actualPaidAmount, paymentDifferenceAmount: linkedPaymentDifference.differenceAmount } : {}) } } : {}),
      ...(accountTransfer ? { systemDisplay: accountTransfer } : {}),
      ...(investmentFlow !== null ? { systemDisplay: { kind: "investment" as const, cashFlow: investmentFlow } } : {}),
      ...(cardSettlementDeposit ? { systemDisplay: { kind: "cardSettlementDeposit" as const } } : {}),
      ...(cardSettlementDifference ? { systemDisplay: { kind: "cardSettlementDifference" as const, matchedGrossAmount: snapshotNumber("matchedGrossAmount"), depositAmount: snapshotNumber("depositAmount"), differenceAmount: snapshotNumber("differenceAmount") } } : {}),
      ...(cardFeeMonthClose ? { systemDisplay: { kind: "cardFeeMonthClose" as const } } : {}),
      items: [],
    });
  }

  for (const row of candidates) {
    const partyId = row.proposed_party_id == null ? null : value(row.proposed_party_id);
    const defaults = partyId === null ? undefined : partnerDefaultsByParty.get(partyId);
    const resolution = defaults?.paymentMode === "postpaid" ? "payable" : defaults?.paymentMode === "unspecified" ? undefined : "verification_pending";
    const partyMissing = !row.party?.name?.trim();
    const partyName = inventorySupplierName(row);
    const partyIdentity = inventoryPartyIdentity(partyId, partyName);
    const accountName = resolution === "payable" ? "미지급" : resolution === "verification_pending" ? "결제 미확인" : null;
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

export type ReserveEntryType = "allocate" | "release" | "consume" | "adjustment";

export type ReserveEntryRow = {
  id: number | string;
  reserve_plan_id: number | string;
  entry_type: string;
  amount: number | string;
  occurred_at: string;
  memo?: string | null;
};

export type ReservePlanRow = {
  id: number | string;
  name: string;
  fund_account_id?: number | string | null;
};

const RESERVE_ENTRY_TYPES = new Set<string>(["allocate", "release", "consume", "adjustment"]);

// Builds read-only reserve history rows for the month's date groups. Business
// date follows occurred_at in Asia/Ho_Chi_Minh with the 03:00 cutoff, exactly
// like ledger transactions. Rows outside `month` are dropped here, so callers
// may pass the cumulative entry set used for reserve balances unchanged.
export function buildReserveLedgerEntries(
  reserveEntries: readonly ReserveEntryRow[],
  plans: readonly ReservePlanRow[],
  accountNameById: ReadonlyMap<number, string>,
  month: string,
  businessDateOf: (date: Date) => string,
): LedgerEntry[] {
  const planById = new Map(plans.map(plan => [value(plan.id), plan]));
  const rows: LedgerEntry[] = [];
  for (const row of reserveEntries) {
    if (!RESERVE_ENTRY_TYPES.has(row.entry_type)) continue;
    const sortTimestamp = Date.parse(row.occurred_at);
    if (!Number.isFinite(sortTimestamp)) continue;
    const businessDate = businessDateOf(new Date(sortTimestamp));
    if (businessDate.slice(0, 7) !== month) continue;
    const reservePlanId = value(row.reserve_plan_id);
    const plan = planById.get(reservePlanId);
    const reserveName = plan?.name?.trim() || "준비금";
    const fundAccountId = plan?.fund_account_id == null ? null : value(plan.fund_account_id);
    const entryType = row.entry_type as ReserveEntryType;
    const amount = value(row.amount);
    const signedAmount = entryType === "release" || entryType === "consume" ? -amount : amount;
    rows.push({
      id: `reserve-entry:${value(row.id)}`,
      businessDate,
      direction: "transfer",
      participatesInProfit: false,
      origin: "auto",
      status: "confirmed",
      isSystemAdjustment: false,
      title: reserveName,
      subtitle: "",
      memo: row.memo ?? null,
      // Neutral, unsigned display amount; signedAmount keeps the balance effect.
      amount: Math.abs(amount),
      fundFlow: "none",
      economicEffectSign: 0,
      displayTime: vietnamTimeFormatter.format(new Date(sortTimestamp)),
      sortTimestamp,
      accountName: fundAccountId == null ? null : accountNameById.get(fundAccountId) ?? null,
      categoryName: null,
      transactionId: null,
      drilldown: "generic",
      systemDisplay: { kind: "reserve", reserveEntryId: value(row.id), reservePlanId, reserveName, entryType, signedAmount },
      items: [],
    });
  }
  return rows;
}

// A payable payment whose actual cash-out exceeded the payable carries its
// linked difference (e.g. Mega Market 9/11: 11,862,000₫ + 600₫) inside the
// payment row. This adds a display-only [조정] row for that difference so the
// 조정 filter can show it. 전체 never lists it, and its expense stays counted
// once — through the payment row's subtotal.
export function withPaymentDifferenceAdjustments(entries: readonly LedgerEntry[]): LedgerEntry[] {
  const derived: LedgerEntry[] = [];
  for (const entry of entries) {
    const display = entry.systemDisplay;
    if (display?.kind !== "payablePayment" || !(Number(display.paymentDifferenceAmount) > 0)) continue;
    derived.push({
      id: `${entry.id}:payment-difference`,
      businessDate: entry.businessDate,
      direction: "expense",
      participatesInProfit: false,
      origin: entry.origin,
      status: "confirmed",
      isSystemAdjustment: false,
      title: `${display.partyName || "미지급금"} 지급차액`,
      subtitle: "",
      memo: entry.memo ?? null,
      amount: Number(display.paymentDifferenceAmount),
      fundFlow: "none",
      economicEffectSign: 1,
      displayTime: entry.displayTime,
      sortTimestamp: entry.sortTimestamp,
      accountName: entry.accountName,
      categoryName: null,
      transactionId: null,
      partyId: entry.partyId ?? null,
      drilldown: "generic",
      userAdjustment: "paymentDifference",
      paymentDifference: { paymentEntryId: entry.id, partyName: display.partyName },
      items: [],
    });
  }
  return derived.length ? [...entries, ...derived] : [...entries];
}
