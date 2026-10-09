"use client";

import type { PaymentMode } from "@/lib/partners/policy";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import InventoryProjectionResolution, { type InventoryProjectionIssue } from "@/components/ledger/InventoryProjectionResolution";
import Link from "next/link";
import type { PayablePeriodSummary } from "@/lib/ledger/payables";
import { formatCardSettlementRate } from "@/lib/ledger/card-settlements";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import {
  BarField,
  BarSegmentedControl,
  BarSheet,
  dangerButtonStyle,
  keepingInputStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
} from "@/components/bar/keeping/KeepingUi";
import {
  entryDisplaySubtotal,
  isPayrollPaymentOutflow,
  compareLedgerEntriesByDisplayTime,
  withPaymentDifferenceAdjustments,
  type LedgerEntry,
  type LedgerEntryItem,
} from "@/lib/ledger/entries";
import { entryFilterHeaderAmount, entryMatchesListFilter, LEDGER_ENTRY_FILTERS, ledgerEntryFilterLabel, type LedgerEntryFilter } from "@/lib/ledger/entry-list-filter";
import { ledgerMonthHref, selectedLedgerMonth } from "@/lib/ledger/month-query";
import { reserveEntryTypeLabel } from "@/lib/ledger/reserve-text";
import { chooseLedgerEntryEmoji, EMPLOYEE_COST_EMOJI, entryCategoryEmoji, ledgerPartyEmoji } from "@/lib/ledger/entry-display-emoji";
import { entryDisplayBadgeEmoji, entryDisplayBadgeKind, entryDisplayBadgeLabel } from "@/lib/ledger/entry-display-badge";
import { entryDisplayAmount, entryDisplayAmountSign, entryDisplayAmountTone } from "@/lib/ledger/entry-display-amount";
import { accountTransferBadgeLabel, shortLedgerAccountName } from "@/lib/ledger/entry-display-account";
import { groupPayableRows, groupPayableRowsByMonth, latestPayableMonth } from "@/lib/ledger/payable-date-groups";
import {
  formatLedgerAmountInput,
  parseLedgerAmount,
  sanitizeLedgerAmountInput,
} from "@/lib/ledger/manual-entry-amount";
import {
  inventoryManualCategoryOptions,
  isManualExpenseCategory,
  isManualIncomeCategory,
  isPayrollAdvanceManualAction,
  MANUAL_EXPENSE_SPECIAL_ACTIONS,
  manualExpenseCategoryLabel,
  manualExpenseCategorySort,
  manualExpenseSpecialActionLabel,
  manualIncomeCategorySort,
  payrollAdvanceDefaultMemo,
} from "@/lib/ledger/manual-entry-policy";
import styles from "./entries.module.css";
import { entryStatusReason } from "@/lib/ledger/entry-status-reason";
import MonthCloseSheet from "./MonthCloseSheet";
import PartnerSelect from "./PartnerSelect";
import ManualDisplayEditor, { LedgerEditShell } from "./ManualDisplayEditor";
import ManualDisplayHistory from "./ManualDisplayHistory";
import PaymentVerificationSection, { type Verification } from "./PaymentVerificationSection";
import { planPartialPayablePayment } from "@/lib/ledger/partial-payable-payment";
import { groupPayablesForDisplay, groupPaymentsByDate } from "@/lib/ledger/payable-display-groups";
import { getBusinessDate } from "@/lib/common/business-time";
import { groupPayrollAdvanceEmployees, type PayrollAdvanceEmployee } from "@/lib/ledger/payroll-advance";
import { adminUsersText } from "@/lib/text/admin-users";

type Account = {
  id: number;
  code: string;
  type: string;
  display_name: string;
  is_active: boolean;
  is_business_fund: boolean;
  balance: number;
  openingBalance: number;
  reserveTotal: number;
  availableBalance: number;
  reserves: Array<{
    id: number;
    name: string;
    currentAmount: number;
    linkedRecurringSourceKeyPrefix: string | null;
  }>;
};
type Category = {
  id: number;
  name: string;
  kind: "income" | "expense";
  parent_id: number | null;
  parent?: { name?: string } | null;
};
type Partner = {
  id: number;
  name: string;
  ledgerPartyId: number;
  partnerType: string;
  partnerSubtypeId: number | null;
  partnerSubtypeCode: string | null;
  emoji: string;
  manualExpenseCategoryId: number | null;
  manualExpenseCategoryName: string | null;
  paymentMode: PaymentMode;
  defaultFundAccountId: number | null;
  isActive: boolean;
};
type LedgerSummary = {
  income: number;
  salesIncome: number;
  otherIncome: number;
  receivedIncome: number;
  expense: number;
  operatingProfit: number;
  paidExpense: number;
  displayedExpense: number;
  actualCashOutflow: number;
  cardSettlementDifference: number;
  cardGrossSales: number;
  monthlySettledGross: number;
  actualCardDeposits: number;
  unsettledCardGross: number;
};
type LedgerData = {
  inventoryProjectionIssues?: InventoryProjectionIssue[];
  month: string;
  fundsView: {
    month: string;
    mode: "live" | "provisional" | "closed_snapshot";
    asOf: string;
    businessDateExclusive: string | null;
  };
  summary: LedgerSummary;
  accounts: Account[];
  categories: Category[];
  partners: Partner[];
  entries: LedgerEntry[];
};
type EntryFilter = LedgerEntryFilter;
type EntryType = "expense" | "income" | "transfer" | "balance_adjustment";
type CandidateDraft = {
  item: LedgerEntryItem;
  resolution: "" | "immediate" | "payable" | "verification_pending";
  categoryId: string;
  fundAccountId: string;
  partyId: string;
  memo: string;
};
type ConfirmedEditDraft = {
  item: LedgerEntryItem;
  paymentMode: "immediate" | "payable";
  categoryId: string;
  fundAccountId: string;
  dueDate: string;
  amount: string;
  memo: string;
  reason: string;
};
type MealAdjustDraft = {
  finalAmount: string;
  reason: string;
};
type DateGroup = {
  date: string;
  rows: LedgerEntry[];
  income: number;
  expense: number;
  // Single-amount filters (결제/카드/이체/조정/투자금/준비금): sum of visible display amounts.
  filterAmount: number | null;
};
type PayableParty = PayablePeriodSummary & { partyId:number; partyName:string; partnerType:string|null; outstandingAmount:number; partialPaidAmount:number; totalOpenAmount:number; openCount:number; oldestDate?:string; nearestDueDate?:string|null; recentPaymentDate?:string|null };
type PayablesSummary = { month:string; summary:PayablePeriodSummary; totalOutstanding:number; parties:PayableParty[]; payables:PayableRow[]; verification?:Verification };
type PayableRow = { id:number; party_id:number; original_amount:number; paidAmount?:number; outstandingAmount:number; settlementStatus?:"paid"|"partial"|"unpaid"; expense:{business_date:string;source_snapshot?:Record<string,unknown>|null;display_snapshot?:Record<string,unknown>|null;memo?:string|null}|null };
type PayableHistoryRow = PayableRow & { paidAmount:number; settlementStatus:"paid"|"partial"|"unpaid" };
type PayablePaymentHistory = { id:number; business_date:string; amount:number|string; memo:string|null; movements?:Array<{fund_account:{display_name:string}|null}>; allocations?:Array<{payable_id:number;allocated_amount:number|string}> };
type PayableDetail = { party:{id:number;name:string}; payables:PayableRow[]; payments?:PayablePaymentHistory[]; totalOutstanding:number };
type CardSettlementSummary = { monthlyCardGross:number; monthlySettledGross:number; monthlyUnreconciledGross:number; monthlySettlementDifference:number; totalUnreconciledGross:number; cardPendingBalance:number };
type InvestmentEntryType = "opening" | "contribution" | "adjustment";
type InvestmentEvent = { investmentId:number; participantId:number; participantName:string; entryType:InvestmentEntryType; amount:number; businessDate:string; occurredAt:string; fundAccountId:number|null; fundAccountName:string|null; reason:string|null };
type InvestmentSummary = { openingCumulative:number; periodOpening:number; periodContribution:number; periodAdjustment:number; periodNetChange:number; closingCumulative:number };
type InvestmentParticipant = InvestmentSummary & { participantId:number; participantName:string };
type InvestmentHeaderSummary = { month: string; configured: boolean; periodNetChange: number };
type InvestmentsData = { month:string; configured:boolean; summary:InvestmentSummary; participants:InvestmentParticipant[]; events:InvestmentEvent[] };
type MonthCloseState = { month: string; state: "open" | "closed" | "reopened"; revision: number | null };
const accountEmoji = (code:string,type:string) => code === "card_clearing" || type === "card_clearing" ? "💳" : code === "store_cash" ? "💵" : type === "personal_custody" || code.endsWith("_personal_custody") ? "👤" : "🏦";

const currentMonth = () => getBusinessDate().slice(0, 7);
const localTime = () =>
  new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 16);
const money = (amount: number) =>
  `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(amount))} ₫`;
const amountClassByTone = { income: styles.amountIncome, expense: styles.amountExpense, transfer: styles.amountTransfer };
const investmentChartChange = (amount: number) => {
  const sign = amount < 0 ? "-" : amount > 0 ? "+" : "";
  return `${sign}${Math.round(Math.abs(amount) / 100_000) / 10}tr`;
};
const payableNumber = (amount: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(amount));
const sanitizeLedgerDecimalAmount = (input: string) => {
  const normalized = input.replace(/,/g, "").replace(/[^\d.]/g, "");
  const dot = normalized.indexOf(".");
  const integerSource = dot < 0 ? normalized : normalized.slice(0, dot);
  const integer = integerSource.replace(/^0+(?=\d)/, "");
  if (dot < 0) return integer;
  return `${integer || "0"}.${normalized.slice(dot + 1).replace(/\./g, "").slice(0, 3)}`;
};
const formatLedgerDecimalAmount = (input: string) => {
  const [integer = "", fraction] = input.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};
const accountShortName: Record<string, string> = {
  store_cash: "현금",
  vuong_personal_custody: "개인(Vương)",
  cho_personal_custody: "개인(Cho)",
  baba_corporate_bank: "법인",
};
const accountOrder: Record<string, number> = {
  store_cash: 0,
  baba_corporate_bank: 1,
  vuong_personal_custody: 2,
  cho_personal_custody: 3,
};

const monthNoticeCardStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
};
const monthControlStyle: CSSProperties = {
  marginTop: 8,
  display: "grid",
  gridTemplateColumns: "auto 1fr auto",
  gap: 8,
};
const monthButtonStyle: CSSProperties = {
  ...ui.button,
  padding: "9px 10px",
  borderRadius: 10,
  fontSize: 12,
  fontWeight: 800,
};
const monthInputStyle: CSSProperties = {
  ...ui.input,
  width: "100%",
  minWidth: 0,
  padding: "9px 10px",
  fontSize: 13,
  borderRadius: 10,
};

function LedgerEntriesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedMonth = searchParams.get("month");
  const businessMonth = currentMonth();
  const month = selectedLedgerMonth(requestedMonth, businessMonth);
  function selectMonth(nextMonth: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(nextMonth)) return;
    setLoading(true);
    router.push(ledgerMonthHref(pathname, searchParams.toString(), nextMonth), { scroll: false });
  }
  const { lang } = useLanguage(),
    vi = lang === "vi";
  const [data, setData] = useState<LedgerData | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [monthCloseState, setMonthCloseState] = useState<MonthCloseState | null>(null);
  const [filter, setFilter] = useState<EntryFilter>("all"),
    [search, setSearch] = useState(""),
    [manualOpen, setManualOpen] = useState(false),
    [selected, setSelected] = useState<LedgerEntry | null>(null),
    [candidateDraft, setCandidateDraft] = useState<CandidateDraft | null>(null),
    [openingExpanded, setOpeningExpanded] = useState(false),
    [balanceExpanded, setBalanceExpanded] = useState(false),
    [reserveExpanded, setReserveExpanded] = useState<Set<string>>(() => new Set()),
    [payableExpanded, setPayableExpanded] = useState(false),
    [payables, setPayables] = useState<PayablesSummary | null>(null),
    [payableParty, setPayableParty] = useState<(PayableParty & {viewMonth:string}) | null>(null);
  const [saving, setSaving] = useState(false),
    [detailMessage, setDetailMessage] = useState(""),
    [posDetail, setPosDetail] = useState<Record<string, unknown> | null>(null),
    [expandedDates, setExpandedDates] = useState<Set<string>>(() => new Set()),
    [historyExpanded, setHistoryExpanded] = useState(false);
  const [cardSettlementExpanded,setCardSettlementExpanded]=useState(false),
    [cardSettlement,setCardSettlement]=useState<{month:string;summary:CardSettlementSummary}|null>(null),
    [cardSettlementError,setCardSettlementError]=useState<{month:string;message:string}|null>(null);
  const [investmentExpanded,setInvestmentExpanded]=useState(false),
    [investments,setInvestments]=useState<InvestmentsData|null>(null),
    [investmentsError,setInvestmentsError]=useState<{month:string;message:string}|null>(null);
  // Bumped by every applied load() so a later investments read can't reuse pre-mutation data.
  const [investmentsVersion,bumpInvestmentsVersion]=useReducer((version:number)=>version+1,0);
  // Collapsed-header summary (mode=summary), loaded with the page. A reducer keeps the
  // existing useState order intact.
  const [investmentSummary,setInvestmentSummary]=useReducer((_:InvestmentHeaderSummary|null,next:InvestmentHeaderSummary|null)=>next,null);
  const investmentsLoadedKeyRef = useRef("");
  const [reopenSheetOpen, setReopenSheetOpen] = useState(false),
    [reopenReason, setReopenReason] = useState(""),
    [reopening, setReopening] = useState(false),
    [reopenError, setReopenError] = useState("");
  const [closeSheetOpen, setCloseSheetOpen] = useState(false);
  const closed = monthCloseState?.month === month && monthCloseState.state === "closed";
  const addButtonRef = useRef<HTMLButtonElement>(null),
    closeButtonRef = useRef<HTMLButtonElement>(null),
    initializedMonthRef = useRef(""),
    loadRequestSequenceRef = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal, { silent = false }: { silent?: boolean } = {}) => {
      const requestedMonth = month;
      const requestSequence = ++loadRequestSequenceRef.current;
      if (!silent) setLoading(true);
      setError("");
      try {
        // Initial load: ledger, month-close status (closure row only — the preflight runs
        // when MonthCloseSheet opens), payables and the investment header summary.
        // Full investments load on demand, below. The summary never fails the load.
        const investmentSummaryPromise = (async () => {
          try {
            const response = await fetch(`/api/admin/ledger/investments?month=${requestedMonth}&mode=summary`, { cache: "no-store", signal });
            const body = await response.json();
            return response.ok && body?.month === requestedMonth && typeof body.configured === "boolean"
              ? { month: requestedMonth, configured: body.configured as boolean, periodNetChange: Number(body.periodNetChange) || 0 }
              : null;
          } catch {
            return null;
          }
        })();
        const [ledgerResponse, closeResponse, payableResponse, summaryResult] = await Promise.all([
          fetch(`/api/admin/ledger?month=${requestedMonth}`, {
            cache: "no-store",
            signal,
          }),
          fetch(`/api/admin/ledger/month-close?month=${requestedMonth}&mode=status`, {
            cache: "no-store",
            signal,
          }),
          fetch(`/api/admin/ledger/payables?month=${requestedMonth}`, { cache: "no-store", signal }),
          investmentSummaryPromise,
        ]);
        const [ledgerBody, closeBody, payableBody] = await Promise.all([
          ledgerResponse.json(),
          closeResponse.json(),
          payableResponse.json(),
        ]);
        if (!ledgerResponse.ok || !closeResponse.ok || !payableResponse.ok)
          throw new Error(ledgerBody.code ?? closeBody.code ?? payableBody.code ?? "LOAD_FAILED");
        // Stale-response guard: this response is applied only if (a) its own fetch
        // wasn't aborted, (b) no newer load() call has started since (sequence ref,
        // covers both AbortController-cancelled and plain manual reloads), and
        // (c) each API body's own `month` — when present — still matches what we asked for.
        if (signal?.aborted || requestSequence !== loadRequestSequenceRef.current) return null;
        if (
          (ledgerBody.month && ledgerBody.month !== requestedMonth) ||
          (closeBody.month && closeBody.month !== requestedMonth) ||
          (payableBody.month && payableBody.month !== requestedMonth)
        )
          return null;
        setData(ledgerBody);
        setPayables(payableBody);
        setMonthCloseState({
          month: requestedMonth,
          state: closeBody.state === "closed" || closeBody.state === "reopened" ? closeBody.state : "open",
          revision: typeof closeBody.closure?.revision === "number" ? closeBody.closure.revision : null,
        });
        setInvestmentSummary(summaryResult);
        // Any applied reload (incl. after a save) makes cached investments stale.
        bumpInvestmentsVersion();
        return ledgerBody as LedgerData;
      } catch (cause) {
        if ((cause as Error).name !== "AbortError" && requestSequence === loadRequestSequenceRef.current)
          setError(
            vi
              ? "Không thể tải sổ. Vui lòng thử lại sau."
              : "장부를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
          );
        return null;
      } finally {
        if (!silent && !signal?.aborted && requestSequence === loadRequestSequenceRef.current) setLoading(false);
      }
    },
    [month, vi],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      // Invalidate this in-flight request (and any concurrent manual load() call,
      // e.g. from a save handler) so its response can never land after a newer one.
      loadRequestSequenceRef.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (!cardSettlementExpanded) return;
    const requestedMonth = month;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/ledger/card-settlements?month=${requestedMonth}`, {cache:"no-store",signal:controller.signal});
        const body = await response.json();
        if (!response.ok) throw new Error(body.code);
        if (controller.signal.aborted || (body.month && body.month !== requestedMonth)) return;
        setCardSettlement({month:requestedMonth,summary:body.summary});
        setCardSettlementError(null);
      } catch {
        if (!controller.signal.aborted) setCardSettlementError({month:requestedMonth,message:vi?"Không thể tải tình hình thẻ. Hãy mở trang chi tiết.":"카드 정산 현황을 불러오지 못했습니다. 상세 페이지에서 다시 확인해주세요."});
      }
    })();
    return () => controller.abort();
  }, [cardSettlementExpanded,month,vi]);
  // Investments load like card settlement: only when the section is opened (or the
  // manual-entry sheet needs participants), once per month and ledger reload.
  const investmentsNeeded = investmentExpanded || manualOpen;
  useEffect(() => {
    if (!investmentsNeeded) return;
    const requestedMonth = month;
    const key = `${requestedMonth}:${investmentsVersion}`;
    if (investmentsLoadedKeyRef.current === key) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/ledger/investments?month=${requestedMonth}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json() as InvestmentsData & { code?: string };
        if (controller.signal.aborted || (body?.month && body.month !== requestedMonth)) return;
        if (!response.ok || typeof body?.configured !== "boolean") throw new Error(body?.code ?? "INVESTMENTS_LOAD_FAILED");
        investmentsLoadedKeyRef.current = key;
        setInvestments(body);
        setInvestmentsError(null);
      } catch {
        if (controller.signal.aborted) return;
        setInvestments(null);
        setInvestmentsError({
          month: requestedMonth,
          message: vi
            ? "Không thể tải tình hình vốn góp. Vui lòng thử lại sau."
            : "투자금 현황을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        });
      }
    })();
    return () => controller.abort();
  }, [investmentsNeeded, month, investmentsVersion, vi]);
  const regularEntries = useMemo(() => (data?.entries ?? []).filter((entry) => !entry.isSystemAdjustment), [data?.entries]);
  // Adds display-only [조정] rows for payable-payment differences (조정 filter only).
  const listEntries = useMemo(() => withPaymentDifferenceAdjustments(data?.entries ?? []), [data?.entries]);
  const groups = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase(),
      byDate = new Map<string, DateGroup>();
    // The filter keeps system adjustments hidden (only user-facing
    // adjustments, under 조정) and reserve rows to 전체/준비금.
    for (const entry of listEntries) {
      if (!entryMatchesListFilter(entry, filter)) continue;
      if (
        keyword &&
        !`${entryDisplayTitle(entry, lang)} ${entryMeta(entry, lang)} ${entry.accountName ?? ""} ${entry.categoryName ?? ""} ${entry.memo ?? ""}`
          .toLocaleLowerCase()
          .includes(keyword)
      )
        continue;
      const group = byDate.get(entry.businessDate) ?? {
        date: entry.businessDate,
        rows: [],
        income: 0,
        expense: 0,
        filterAmount: null,
      };
      group.rows.push(entry);
      const headerAmount = entryFilterHeaderAmount(entry, filter);
      if (headerAmount !== null) {
        group.filterAmount = (group.filterAmount ?? 0) + headerAmount;
        byDate.set(entry.businessDate, group);
        continue;
      }
      // Net corrections/reversals into the day subtotal via economicEffectSign
      // without touching the row's own displayed (always-positive) amount.
      const subtotal = entryDisplaySubtotal(entry);
      group.income += subtotal.income;
      group.expense += subtotal.expense;
      byDate.set(entry.businessDate, group);
    }
    for (const group of byDate.values()) {
      group.rows.sort(compareLedgerEntriesByDisplayTime);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [listEntries, filter, lang, search]);
  const businessAccounts = useMemo(
    () =>
      (data?.accounts ?? [])
        .filter(
          (account) =>
            account.is_active &&
            account.is_business_fund &&
            account.type !== "card_clearing",
        )
        .sort(
          (a, b) => (accountOrder[a.code] ?? 99) - (accountOrder[b.code] ?? 99),
        ),
    [data?.accounts],
  );
  const openingTotal = useMemo(
    () =>
      businessAccounts.reduce(
        (sum, account) => sum + account.openingBalance,
        0,
      ),
    [businessAccounts],
  );
  const currentBalanceTotal = useMemo(
    () => businessAccounts.reduce((sum, account) => sum + account.balance, 0),
    [businessAccounts],
  );
  const balanceDeltaByCode = useMemo(
    () =>
      new Map(
        businessAccounts.map((account) => [
          account.code,
          account.balance - account.openingBalance,
        ]),
      ),
    [businessAccounts],
  );
  // Cash and the corporate bank each take a full-width row; the two personal
  // custody accounts share a row (see .personalAccounts in the stylesheet).
  const primaryBalanceAccounts = useMemo(
    () => businessAccounts.filter((account) => account.type !== "personal_custody"),
    [businessAccounts],
  );
  const personalBalanceAccounts = useMemo(
    () => businessAccounts.filter((account) => account.type === "personal_custody"),
    [businessAccounts],
  );
  // Display-only regrouping: unresolved payment-verification items become the last "기타" row.
  const payableDisplay = useMemo(() => groupPayablesForDisplay(
    payables?.parties ?? [],
    payables?.payables ?? [],
    payables?.month === month ? payables.verification?.items ?? [] : [],
  ), [payables, month]);
  const activeInvestments = investments && investments.month === month ? investments : null;
  // Header: full data when this month's section was opened, otherwise the light summary.
  const investmentHeader: InvestmentHeaderSummary | null = activeInvestments
    ? { month, configured: activeInvestments.configured, periodNetChange: activeInvestments.summary.periodNetChange }
    : investmentSummary?.month === month ? investmentSummary : null;
  const largestParticipantInvestment = Math.max(0, ...(activeInvestments?.participants ?? []).map(participant=>Math.max(participant.openingCumulative,participant.closingCumulative)));
  const todayKey = getBusinessDate();
  const pastGroups = useMemo(
    () => groups.filter((group) => group.date < todayKey),
    [groups, todayKey],
  );
  const remainingGroups = useMemo(
    () => groups.filter((group) => group.date >= todayKey),
    [groups, todayKey],
  );
  const historyOpen =
    (Boolean(search.trim()) && pastGroups.length > 0) || historyExpanded;
  useEffect(() => {
    if (!data || data.month !== month || initializedMonthRef.current === month)
      return;
    const dates = [
        ...new Set(regularEntries.map((entry) => entry.businessDate)),
      ].sort(),
      today = getBusinessDate(),
      defaultDate = dates.includes(today) ? today : dates.at(-1);
    setExpandedDates(defaultDate ? new Set([defaultDate]) : new Set());
    setHistoryExpanded(false);
    initializedMonthRef.current = month;
  }, [data, month, regularEntries]);
  function shiftMonth(delta: number) {
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + delta);
    // Flip to the loading UI in the same render as the month switch itself (batched
    // with setMonth), so there is no in-between frame where the new month's title
    // could paint next to the previous month's still-attached numbers.
    setLoading(true);
    selectMonth(date.toISOString().slice(0, 7));
  }
  async function reopenMonth() {
    const reason = reopenReason.trim();
    if (!reason || reopening || !closed) return;
    setReopening(true);
    setReopenError("");
    try {
      const response = await fetch("/api/admin/ledger/month-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reopen", month, reason }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code ?? "MONTH_REOPEN_FAILED");
      setReopenSheetOpen(false);
      setReopenReason("");
      const fresh = await load();
      if (fresh) {
        setNotice(vi ? "Đã mở lại tháng để kiểm tra." : "월마감을 다시 열었습니다. 장부를 검토할 수 있습니다.");
      }
    } catch (cause) {
      setReopenError((cause as Error).message);
    } finally {
      setReopening(false);
    }
  }
  async function openEntry(entry: LedgerEntry) {
    setSelected(entry);
    setCandidateDraft(null);
    setDetailMessage("");
    setPosDetail(null);
    if (entry.drilldown === "pos" && entry.transactionId) {
      try {
        const response = await fetch(
            `/api/admin/ledger/transactions/${entry.transactionId}/pos-drilldown`,
            { cache: "no-store" },
          ),
          body = await response.json();
        if (!response.ok) throw new Error(body.code);
        setPosDetail(body.drilldown);
      } catch {
        setDetailMessage(
          vi
            ? "Không thể tải chi tiết hóa đơn POS."
            : "POS 영수증 상세를 불러오지 못했습니다.",
        );
      }
    }
  }
  function editCandidate(item: LedgerEntryItem) {
    if (selected && item.candidateId) {
      const draft: CandidateDraft = {
        item,
        resolution: selected.defaultResolution ?? "",
        categoryId: String(item.categoryId ?? ""),
        fundAccountId: String(selected.defaultFundAccountId ?? ""),
        partyId: "",
        memo: "",
      };
      setCandidateDraft(draft);
    }
  }
  async function resolveCandidate() {
    if (!selected || !candidateDraft?.item.candidateId) return;
    if (!candidateDraft.resolution) {
      setDetailMessage(vi ? "Vui lòng chọn phương thức xử lý." : "처리 방식을 선택해주세요.");
      return;
    }
    const partyId = selected.partyId ?? (candidateDraft.resolution === "immediate" ? null :
      data?.partners.find((partner) => partner.isActive && String(partner.id) === candidateDraft.partyId)?.ledgerPartyId ?? null);
    if (candidateDraft.resolution !== "immediate" && partyId == null) {
      setDetailMessage(vi ? "Vui lòng chọn đối tác để ghi nhận công nợ." : "미지급 등록을 위해 거래처를 선택해주세요.");
      return;
    }
    setSaving(true);
    setDetailMessage("");
    try {
      const response = await fetch(
          `/api/admin/ledger/candidates/${candidateDraft.item.candidateId}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              resolution: candidateDraft.resolution,
              categoryId: Number(candidateDraft.categoryId),
              partyId,
              fundAccountId:
                candidateDraft.resolution === "immediate"
                  ? Number(candidateDraft.fundAccountId)
                  : null,
              dueDate: null,
              memo: candidateDraft.memo || null,
              reason: null,
            }),
          },
        ),
        body = await response.json();
      if (!response.ok) throw new Error(body.code);
      setSelected(null);
      setCandidateDraft(null);
      await load();
    } catch (cause) {
      setDetailMessage(
        (cause as Error).message === "PARTY_REQUIRED"
          ? (vi ? "Vui lòng chọn đối tác để ghi nhận công nợ." : "미지급 등록을 위해 거래처를 선택해주세요.")
          : `${vi ? "Không thể ghi sổ." : "반영하지 못했습니다."} ${(cause as Error).message}`,
      );
    } finally {
      setSaving(false);
    }
  }
  function toggleDate(date: string) {
    setExpandedDates((current) => {
      const next = new Set(current);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }
  function toggleReserve(code: string) {
    setReserveExpanded((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }
  function renderBalanceCard(account: Account) {
    const delta = balanceDeltaByCode.get(account.code) ?? 0;
    const deltaClass = delta > 0
      ? styles.balanceDeltaPositive
      : delta < 0
        ? styles.balanceDeltaNegative
        : styles.balanceDeltaZero;
    const showReserve = account.code === "baba_corporate_bank" || account.reserves.length > 0;
    const hasReserve = account.reserveTotal !== 0;
    const reserveOpen = reserveExpanded.has(account.code);
    return (
      <article className={styles.balanceCard} key={account.id}>
        <small className={styles.balanceCardName}>{localizedAccountName(account, lang)}</small>
        <b className={styles.balanceCardValue}>{money(account.balance)}</b>
        <em className={`${styles.balanceDelta} ${deltaClass}`}>
          {delta > 0 ? "+" : ""}{money(delta)}
        </em>
        {showReserve ? (
          <div className={styles.balanceReserve}>
            {hasReserve ? (
              <button
                type="button"
                className={styles.balanceReserveToggle}
                aria-expanded={reserveOpen}
                onClick={() => toggleReserve(account.code)}
              >
                <span>🔒 {vi ? "Tổng quỹ dự phòng" : "준비금 합계"}</span>
                <b>{money(account.reserveTotal)}</b>
                <i aria-hidden>{reserveOpen ? "⌃" : "⌄"}</i>
              </button>
            ) : (
              <span className={styles.balanceReserveToggle}>
                <span>{vi ? "Tổng quỹ dự phòng" : "준비금 합계"}</span>
                <b>{money(account.reserveTotal)}</b>
              </span>
            )}
            {hasReserve && reserveOpen ? (
              <div className={styles.balanceReserveList}>
                {account.reserves
                  .filter((reserve) => reserve.currentAmount !== 0)
                  .map((reserve) => (
                    <span key={reserve.id}>
                      <small>{reserveLabel(reserve, lang)}</small>
                      <b>{money(reserve.currentAmount)}</b>
                    </span>
                  ))}
              </div>
            ) : null}
            <span className={styles.balanceAvailable}>
              <small>{vi ? "Số dư khả dụng" : "사용 가능 잔액"}</small>
              <b>{money(account.availableBalance)}</b>
            </span>
          </div>
        ) : null}
      </article>
    );
  }
  const partnerByLedgerParty = useMemo(
    () => new Map((data?.partners ?? []).map((partner) => [partner.ledgerPartyId, partner] as const)),
    [data?.partners],
  );  function renderDateGroup(group: DateGroup) {
    const expanded =
        Boolean(search.trim()) || expandedDates.has(group.date),
      panelId = `ledger-date-${group.date}`;
    return (
      <section className={styles.dateGroup} key={group.date}>
        <button
          type="button"
          className={styles.dateHeader}
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => toggleDate(group.date)}
        >
          <strong>{formatDate(group.date, lang)}</strong>
          <span className={styles.dateSummary}>
            <span>{group.rows.length} {vi ? "giao dịch" : "건"}</span>
            {group.filterAmount !== null ? <><i aria-hidden>·</i><b className={styles.dateFilterAmount}>{ledgerEntryFilterLabel(filter, lang)} {group.filterAmount < 0 ? "−" : filter === "investment" && group.filterAmount > 0 ? "+" : ""}{money(Math.abs(group.filterAmount))}</b></> : null}
            {group.filterAmount === null && group.income > 0 ? <><i aria-hidden>·</i><b className={styles.dateIncome}>{vi ? "Thu" : "수입"} {money(group.income)}</b></> : null}
            {group.filterAmount === null && group.expense > 0 ? <><i aria-hidden>·</i><b className={styles.dateExpense}>{vi ? "Chi" : "지출"} {money(group.expense)}</b></> : null}
          </span>
          <i
            aria-hidden
            className={
              expanded
                ? styles.dateChevronOpen
                : styles.dateChevron
            }
          >
            ›
          </i>
        </button>
        {expanded ? (
          <div id={panelId}>
            {group.rows.map((entry) => (
              <button type="button" className={styles.entryRow} key={entry.id} onClick={() => void openEntry(entry)}>
                <span className={styles.entryLeft}>
                  <EntryDisplayBadge entry={entry} lang={lang} />
                  <span className={styles.entryCategoryEmoji} role="img" aria-label={entry.partyId == null ? entry.categoryName ?? (vi ? "Danh mục" : "카테고리") : partnerByLedgerParty.get(entry.partyId)?.name ?? (vi ? "Đối tác" : "거래처")}>
                    {entryDisplayEmoji(entry, partnerByLedgerParty)}
                  </span>
                  <span className={styles.entryMain}>
                    <strong>{compactEntryListTitle(entryDisplayTitle(entry, lang))}</strong>
                    <EntryListFlags entry={entry} lang={lang} />
                    {entryMeta(entry, lang) ? <span> · {entryMeta(entry, lang)}</span> : null}
                  </span>
                </span>
                <span className={styles.entryRight}>
                  <small className={styles.entryTime}>{entry.displayTime ?? ""}</small>
                  <span className={styles.entryBottom}>
                    <span className={[styles.accountBadge, isPayableAccount(entry.accountName) ? styles.accountBadgePayable : "", entry.systemDisplay?.kind === "cardSettlementDeposit" ? styles.accountBadgeCardSettlement : "", entry.systemDisplay?.kind === "accountTransfer" ? styles.accountBadgeAccountTransfer : ""].join(" ")}
                      title={entry.accountName ?? (vi ? "Không có tài khoản" : "계정 없음")}>
                      {accountBadgeLabel(entry.accountName, lang, entry)}
                    </span>
                    <strong className={amountClassByTone[entryDisplayAmountTone(entry)]}>
                      {entryDisplayAmountSign(entry)}{money(entryDisplayAmount(entry))}
                    </strong>
                    <span aria-hidden className={styles.chevron}>›</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    );
  }
  return (
    <Container noPaddingTop>
      <main className={`${styles.page} ${balanceExpanded ? styles.balanceExpandedPage : ""}`}>
        <button
          ref={addButtonRef}
          type="button"
          disabled={closed || data?.month !== month}
          className={styles.addButton}
          onClick={() => setManualOpen(true)}
        >
          {vi ? "Thêm giao dịch" : "장부 내역 추가"}
        </button>
        <section
          style={monthNoticeCardStyle}
          aria-label={vi ? "Chọn tháng" : "월 선택"}
        >
          <div style={monthControlStyle}>
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              aria-label={vi ? "Tháng trước" : "이전 달"}
              style={monthButtonStyle}
            >
              {vi ? "Trước" : "이전"}
            </button>
            <input
              type="month"
              value={month}
              onChange={(event) => {
                setLoading(true);
                selectMonth(event.target.value);
              }}
              aria-label={vi ? "Chọn tháng" : "월 선택"}
              style={monthInputStyle}
            />
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              aria-label={vi ? "Tháng sau" : "다음 달"}
              style={monthButtonStyle}
            >
              {vi ? "Sau" : "다음"}
            </button>
          </div>
        </section>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {data && data.month === month && data.inventoryProjectionIssues?.length ? (
          <section className={styles.projectionWarning} role="status">
            <strong>⚠️ {vi ? "Cần kiểm tra ghi sổ nhập kho" : "입고 수정 장부 반영 확인 필요"}</strong>
            <p>{data.inventoryProjectionIssues.every(issue => issue.code === "PURCHASE_CORRECTION_REFERENCE_REQUIRED")
              ? vi
                ? `${data.inventoryProjectionIssues.length} thay đổi số lượng nhập kho chưa được ghi vào sổ.`
                : `${data.inventoryProjectionIssues.length}건의 입고 수정이 장부에 반영되지 않았습니다.`
              : vi
                ? `${data.inventoryProjectionIssues.length} thay đổi nhập kho cần kiểm tra trong sổ.`
                : `${data.inventoryProjectionIssues.length}건의 입고 내역에 장부 확인이 필요합니다.`}</p>
            <details>
              <summary>{vi ? "Xem chi tiết" : "상세 보기"}</summary>
              {data.inventoryProjectionIssues.map(issue => <div className={styles.projectionWarningRow} key={issue.inventoryLogId}>
                <span className={styles.projectionWarningSummary}>
                  <span className={styles.projectionWarningSupplier} title={issue.supplier || undefined}>{issue.supplier || (vi ? "Chưa xác định" : "거래처 미확정")}</span>
                  <span aria-hidden="true"> · </span>
                  <strong className={styles.projectionWarningItem} title={vi ? issue.itemNameVi || issue.itemName : issue.itemName}>{vi ? issue.itemNameVi || issue.itemName : issue.itemName}</strong>
                  <span className={styles.projectionWarningDate}> · {issue.businessDate ? Number(issue.businessDate.slice(5, 7)) + "/" + Number(issue.businessDate.slice(8, 10)) : "—"}</span>
                </span>
                <InventoryProjectionResolution issue={issue} vi={vi} onResolved={async () => {
                  const refreshed = await load();
                  if (!refreshed) throw new Error("LEDGER_REFRESH_FAILED");
                  setNotice(vi ? "Đã điều chỉnh sổ kế toán" : "장부 정정 완료");
                }} />
              </div>)}
            </details>
          </section>
        ) : null}
        {notice ? (
          <p className={styles.success} role="status">
            {notice}
          </p>
        ) : null}
        {data?.month === month && monthCloseState?.month === month &&
          (monthCloseState.state !== "open" || month < businessMonth) ? (
          <section className={`${styles.monthCloseCard} ${monthCloseState.state === "reopened" ? styles.monthCloseReopened : ""}`}
            aria-label={vi ? "Trạng thái chốt sổ" : "월마감 상태"}>
            <div className={styles.monthCloseText}>
              <strong>{monthCloseState.state === "closed"
                ? vi ? `Sổ tháng ${Number(month.slice(5, 7))} đã chốt` : `${Number(month.slice(5, 7))}월 장부 마감됨`
                : monthCloseState.state === "reopened"
                  ? vi ? `Đang kiểm tra lại tháng ${Number(month.slice(5, 7))}` : `${Number(month.slice(5, 7))}월 재검토 중`
                  : vi ? `Sổ tháng ${Number(month.slice(5, 7))} chưa chốt` : `${Number(month.slice(5, 7))}월 장부 마감 전`}</strong>
              <p>{monthCloseState.state === "closed"
                ? vi ? `Đã chốt lần ${monthCloseState.revision ?? 1} · Mở lại để sửa sổ.`
                  : `${monthCloseState.revision ?? 1}차 마감 · 수정하려면 마감을 다시 열어야 합니다.`
                : monthCloseState.state === "reopened"
                  ? vi ? `Giữ bản chốt lần ${monthCloseState.revision ?? 1} · Có thể sửa` : `${monthCloseState.revision ?? 1}차 마감본 보존 · 수정 가능`
                  : vi ? "Có thể kiểm tra và chốt sổ" : "점검 후 장부를 마감할 수 있습니다."}</p>
            </div>
            {monthCloseState.state === "closed"
              ? <button type="button" className={styles.monthCloseAction}
                  onClick={() => { setReopenError(""); setReopenSheetOpen(true); }}>
                  {vi ? "Mở lại sổ" : "마감 다시 열기"}
                </button>
              : <button type="button" ref={closeButtonRef} className={styles.monthCloseAction}
                  onClick={() => { setCloseSheetOpen(true); }}>
                  {monthCloseState.state === "reopened"
                    ? vi ? `Chốt lại tháng ${Number(month.slice(5, 7))}` : `${Number(month.slice(5, 7))}월 다시 마감`
                    : vi ? `Chốt tháng ${Number(month.slice(5, 7))}` : `${Number(month.slice(5, 7))}월 마감`}
                </button>}
          </section>
        ) : null}
        {data && data.month === month ? (
          <>
            <section
              className={styles.summaryGrid}
              aria-label={vi ? "Tổng hợp sổ tháng" : "월 장부 요약"}
            >
              <article className={`${styles.summaryCard} ${styles.incomeCard}`}>
                <span className={styles.summaryLabel}>
                  <i aria-hidden="true">💰</i>
                  {vi ? "Thu" : "수입"}
                </span>
                <div className={styles.summarySubRows}>
                  <span><span className={styles.summarySubLabel}>{vi ? "Thực thu bán hàng" : "실제 매출입금"}</span><b>{money(data.summary.receivedIncome - data.summary.otherIncome)}</b></span>
                  <span><span className={styles.summarySubLabel}>{vi ? "Thu nhập khác" : "기타수입"}</span><b>{money(data.summary.otherIncome)}</b></span>
                </div>
              </article>
              <article className={`${styles.summaryCard} ${styles.expenseCard}`}>
                <span className={styles.summaryLabel}>
                  <i aria-hidden="true">💸</i>
                  {vi ? "Chi" : "지출"}
                </span>
                <div className={styles.summarySubRows}>
                  <span><span className={styles.summarySubLabel}>{vi ? "Thực chi" : "실제 지출"}</span><b>{money(data.summary.actualCashOutflow)}</b></span>
                  <span><span className={styles.summarySubLabel}>{vi ? "Phí thẻ · chênh lệch" : "카드 수수료·정산차액"}</span><b>{money(data.summary.cardSettlementDifference)}</b></span>
                </div>
              </article>
            </section>
            <section
              className={styles.openingSection}
              aria-labelledby="opening-title"
            >
              <button type="button" className={styles.openingToggle} aria-expanded={openingExpanded} onClick={() => setOpeningExpanded((value) => !value)}>
              <div className={styles.sectionTitle}>
                <h2 id="opening-title">
                  <span aria-hidden="true">🏦</span>
                  {vi ? "Số dư đầu tháng" : "당월 시재"}
                </h2>
                <span>{vi ? "Cố định đầu tháng" : "월초 고정"}</span>
              </div>
              <div className={styles.openingTotal}>
                <span>{vi ? "Tổng số dư đầu tháng" : "시재 합계"}</span>
                <strong>{money(openingTotal)} <i aria-hidden>{openingExpanded ? "⌃" : "⌄"}</i></strong>
              </div>
              </button>
              {openingExpanded ? <div className={styles.openingGrid}>
                {businessAccounts.map((account) => (
                  <article key={account.id}>
                    <span><i className={styles.accountEmoji} aria-hidden="true">{accountEmoji(account.code,account.type)}</i> {localizedAccountName(account, lang)}</span>
                    <strong>{money(account.openingBalance)}</strong>
                  </article>
                ))}
              </div> : null}
            </section>
            <section className={styles.payableSummary} aria-labelledby="payable-summary-title">
                <button type="button" className={styles.payableToggle} aria-expanded={payableExpanded} aria-controls="payable-summary-body" onClick={() => setPayableExpanded((value) => !value)}>
                  <div className={styles.payableHeading}><h2 id="payable-summary-title">🧾 {vi ? "Tình hình công nợ" : "미납금 현황"} ({vi?`T${Number(month.slice(5,7))}`:`${Number(month.slice(5,7))}월`})</h2><strong aria-label={vi?"Công nợ cuối tháng":"월말 미납"}>{money(payables?.totalOutstanding ?? 0)} <i aria-hidden>{payableExpanded ? "⌃" : "⌄"}</i></strong></div>
                </button>
              {payableExpanded ? <div className={styles.statusBody} id="payable-summary-body">
              <PayableMonthTotals summary={payables?.month===month?payables.summary:undefined} vi={vi} />
              {payableDisplay.parties.length || payableDisplay.other ? (
                <div className={styles.payableParties} id="payable-parties-list">{payableDisplay.parties.map((party) => <button type="button" key={party.partyId} onClick={() => setPayableParty({...party,viewMonth:month})}>
                  <span className={styles.payablePartyMain}><span className={styles.payablePartyEmoji} role="img" aria-label={partnerTypeLabel(party.partnerType,lang)}>{ledgerPartyEmoji(partnerByLedgerParty.get(party.partyId)?.emoji,party.partnerType)}</span><span className={styles.payablePartyName}>{party.partyName}</span>
                    <small className={styles.payablePartyPeriod}>{vi ? `Phát sinh T${Number(month.slice(5,7))}` : `${Number(month.slice(5,7))}월 외상`}: {payableNumber(party.periodPurchases)} · {vi ? `Thanh toán T${Number(month.slice(5,7))}` : `${Number(month.slice(5,7))}월 지급`}: {payableNumber(party.periodPayments)}</small>
                  </span><strong aria-label={vi ? "Công nợ cuối tháng" : "월말 미납"}>{money(party.closingOutstanding)}</strong><small>{party.openCount}{vi ? " khoản" : "건"}</small><i aria-hidden>›</i>
                </button>)}
                {payableDisplay.other ? <PaymentVerificationSection
                  group={payableDisplay.other}
                  accounts={businessAccounts}
                  vi={vi}
                  canPay={month === currentMonth()}
                  onPaid={async () => { await load(); setNotice(vi ? "Đã ghi nhận thanh toán." : "결제를 기록했습니다."); }}
                /> : null}</div>
              ) : <p className={styles.payableEmpty}>{vi ? "Không có công nợ chưa thanh toán." : "미납금이 없습니다."}</p>}
              </div> : null}
            </section>
            <section className={styles.statusCard} aria-labelledby="card-settlement-title">
              <button type="button" className={styles.payableToggle} aria-expanded={cardSettlementExpanded} aria-controls="card-settlement-body" onClick={()=>setCardSettlementExpanded(value=>!value)}>
                <div className={styles.payableHeading}><h2 id="card-settlement-title">💳 {vi?"Tình hình quyết toán thẻ":"카드 정산 현황"} ({vi?`T${Number(month.slice(5,7))}`:`${Number(month.slice(5,7))}월`})</h2><strong aria-label={vi?"Tỷ lệ quyết toán tháng":"선택월 정산 완료율"}>{data.month===month?formatCardSettlementRate(data.summary.cardGrossSales,data.summary.monthlySettledGross):"-"} <i aria-hidden>{cardSettlementExpanded?"⌃":"⌄"}</i></strong></div>
              </button>
              {cardSettlementExpanded ? <div className={styles.statusBody} id="card-settlement-body">
                <dl className={styles.payableMonthTotals}>
                  {([
                    ["monthlyCardGross",vi?"💳 Doanh thu thẻ":"💳 카드매출"],
                    ["monthlySettledGross",vi?"✅ Đã quyết toán cuối tháng":"✅ 월말 정산완료"],
                    ["monthlyUnreconciledGross",vi?"⏳ Chưa quyết toán cuối tháng":"⏳ 월말 미정산"],
                    ["monthlySettlementDifference",vi?"💸 Phí/chênh lệch theo tháng bán":"💸 매출 귀속 수수료/차액"],
                  ] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{cardSettlement?.month===month&&cardSettlementError?.month!==month?money(cardSettlement.summary[key]):"-"}</dd></div>)}
                </dl>
                <p className={styles.statusHint}>{vi?"Tiền thực nhận tính theo tháng nhập tiền; phí/chênh lệch tính theo tháng bán.":"실제 입금은 입금월 기준, 수수료/차액은 매출월 귀속 기준입니다."}</p>
                {cardSettlementError?.month===month?<p role="alert" className={styles.error}>{cardSettlementError.message}</p>:cardSettlement?.month!==month?<p className={styles.statusHint}>{vi?"Đang tải tình hình thẻ…":"카드 정산 현황을 불러오는 중입니다…"}</p>:null}
                <div className={styles.statusActions}><p className={styles.statusHint}>{vi?"Đăng ký tiền vào và kết nối doanh thu tại trang chi tiết.":"입금 등록과 매출 연결은 상세 페이지에서 진행합니다."}</p><Link href={ledgerMonthHref("/admin/ledger/card-settlements", "", month)} className={styles.statusDetailLink}>{vi?"Xem chi tiết":"상세 보기"} ›</Link></div>
              </div>:null}
            </section>
            <section className={styles.statusCard} aria-labelledby="investment-title">
              <button type="button" className={styles.payableToggle} aria-expanded={investmentExpanded} aria-controls="investment-body" onClick={()=>setInvestmentExpanded(value=>!value)}>
                <div className={styles.payableHeading}>
                  <h2 id="investment-title">💼 {vi?"Tình hình vốn góp":"투자금 현황"} ({vi?`T${Number(month.slice(5,7))}`:`${Number(month.slice(5,7))}월`})</h2>
                  <strong
                    className={investmentHeader?.configured ? (investmentHeader.periodNetChange > 0 ? styles.amountIncome : investmentHeader.periodNetChange < 0 ? styles.amountExpense : undefined) : undefined}
                    aria-label={vi?"Biến động vốn góp trong tháng":"당월 투자금 변동"}
                  >
                    {investmentHeader ? (investmentHeader.configured ? `${investmentHeader.periodNetChange > 0 ? "+" : ""}${money(investmentHeader.periodNetChange)}` : (vi?"Chưa thiết lập":"미설정")) : "-"}
                    {" "}<i aria-hidden>{investmentExpanded?"⌃":"⌄"}</i>
                  </strong>
                </div>
              </button>
              {investmentExpanded ? <div className={styles.statusBody} id="investment-body">
                {!activeInvestments ? (
                  investmentsError?.month===month
                    ? <p role="alert" className={styles.error}>{investmentsError.message}</p>
                    : <p className={styles.statusHint}>{vi?"Đang tải tình hình vốn góp…":"투자금 현황을 불러오는 중입니다…"}</p>
                ) : !activeInvestments.configured ? (
                  <>
                    <p className={styles.payableEmpty}>{vi?"Chưa thiết lập cơ sở vốn góp.":"투자금 기준이 아직 설정되지 않았습니다."}</p>
                    <div className={styles.statusActions}>
                      <p className={styles.statusHint}>{vi?"Thiết lập người góp vốn tại trang quản lý sổ sách của chủ sở hữu.":"참여자와 투자금 기준은 사장 정산 관리 화면에서 설정합니다."}</p>
                      <Link href="/admin/ledger/owners" className={styles.statusDetailLink}>{vi?"Quản lý":"관리"} ›</Link>
                    </div>
                  </>
                ) : (
                  <>
                    <div className={styles.investmentChart} aria-label={vi?"Vốn góp lũy kế theo người":"투자자별 누적 투자금"}>
                      <div className={styles.investmentChartLegend}>
                        <span><i className={styles.investmentPriorKey}/>{vi?"Lũy kế trước tháng":"기존 누적"}</span>
                        <span><i className={styles.investmentIncreaseKey}/>{vi?"Tăng trong tháng":"이번 달 증가"}</span>
                        <span><i className={styles.investmentDecreaseKey}/>{vi?"Giảm trong tháng":"이번 달 감소"}</span>
                      </div>
                      {(activeInvestments.participants ?? []).map(participant=>{
                        const opening = Math.max(0, participant.openingCumulative);
                        const increase = Math.max(0, participant.periodNetChange);
                        const decrease = Math.max(0, -participant.periodNetChange);
                        const percentage = (amount:number) => largestParticipantInvestment > 0 ? amount / largestParticipantInvestment * 100 : 0;
                        return <div className={styles.investmentChartRow} key={participant.participantId}>
                          <strong className={styles.investmentName}>{participant.participantName}</strong>
                          <div className={styles.investmentTrack} role="img" aria-label={`${participant.participantName}: ${vi?"lũy kế cuối tháng":"월말 누적"} ${money(participant.closingCumulative)}${participant.periodNetChange!==0?`, ${vi?"thay đổi trong tháng":"당월 변동"} ${participant.periodNetChange>0?"+":""}${money(participant.periodNetChange)}`:""}`}>
                            {opening>0?<span className={styles.investmentPrior} style={{width:`${percentage(opening)}%`}}><span>{money(participant.closingCumulative)}</span></span>:null}
                            {increase>0?<span className={styles.investmentIncrease} style={{left:`${percentage(opening)}%`,width:`${percentage(increase)}%`}}/>:null}
                            {decrease>0?<span className={styles.investmentDecrease} style={{left:`${percentage(Math.max(0,opening-decrease))}%`,width:`${percentage(decrease)}%`}}/>:null}
                            {opening===0 && increase===0?<span className={styles.investmentZero}>{money(0)}</span>:null}
                          </div>
                          <div className={styles.investmentValues}>
                            {participant.periodNetChange!==0?<strong className={participant.periodNetChange<0?styles.amountExpense:styles.investmentIncreaseValue}>{investmentChartChange(participant.periodNetChange)}</strong>:null}
                          </div>
                        </div>;
                      })}
                    </div>
                    <dl className={styles.payableMonthTotals}>
                      <div><dt>🏁 {vi?"Lũy kế đầu tháng":"월초 누적"}</dt><dd>{money(activeInvestments.summary.openingCumulative)}</dd></div>
                      {activeInvestments.summary.periodOpening!==0?<div><dt>📌 {vi?"Vốn ghi nhận đầu kỳ trong tháng":"당월 기준투자금"}</dt><dd>{activeInvestments.summary.periodOpening>0?"+":""}{money(activeInvestments.summary.periodOpening)}</dd></div>:null}
                      <div><dt>➕ {vi?"Góp vốn tháng này":"당월 추가투자"}</dt><dd>{activeInvestments.summary.periodContribution>0?"+":""}{money(activeInvestments.summary.periodContribution)}</dd></div>
                      <div><dt>🛠️ {vi?"Điều chỉnh tháng này":"당월 조정"}</dt><dd>{activeInvestments.summary.periodAdjustment>0?"+":""}{money(activeInvestments.summary.periodAdjustment)}</dd></div>
                      <div><dt>💼 {vi?"Lũy kế cuối tháng":"월말 누적"}</dt><dd>{money(activeInvestments.summary.closingCumulative)}</dd></div>
                    </dl>
                    <p className={styles.statusHint}>{vi?"Vốn góp được theo dõi lũy kế theo tháng. Khoản góp thêm được tính vào tiền đang giữ, nhưng không tính vào doanh thu hoặc lợi nhuận kinh doanh.":"투자금은 월별 누적 기준으로 추적합니다. 추가투자는 보유금에 포함되며 영업수입·영업이익에는 포함되지 않습니다."}</p>
                    {activeInvestments.events.length ? (
                      <div className={styles.itemList}>
                        {activeInvestments.events.map((event) => (
                          <article key={event.investmentId}>
                            <span className={styles.itemDescription}>
                              <strong>{formatDate(event.businessDate, lang)} · {event.participantName}</strong>
                              <span> · {investmentEntryTypeLabel(event.entryType, event.amount, lang)}</span>
                            </span>
                            <span className={styles.itemAmount}>
                              <b className={event.amount < 0 ? styles.amountExpense : styles.amountIncome}>
                                {event.amount > 0 ? "+" : ""}{money(event.amount)}
                              </b>
                            </span>
                          </article>
                        ))}
                      </div>
                    ) : <p className={styles.payableEmpty}>{vi?"Không có thay đổi vốn góp trong tháng này.":"이번 달 투자금 변동이 없습니다."}</p>}
                  </>
                )}
              </div> : null}
            </section>
            <section
              className={styles.filters}
              aria-label={vi ? "Bộ lọc sổ" : "장부 필터"}
            >
              <div className={styles.filterTabs}>
                {LEDGER_ENTRY_FILTERS.map((value) => [value, ledgerEntryFilterLabel(value, lang)] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={(event) => {
                      setFilter(value);
                      // Keep the chosen pill in view without moving the page vertically.
                      event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={
                  vi
                    ? "Tìm đối tác, nội dung, tài khoản"
                    : "거래처, 내용, 계정 검색"
                }
                aria-label={vi ? "Tìm kiếm sổ" : "장부 검색"}
              />
            </section>
            <section
              className={styles.book}
              aria-label={vi ? "Sổ hàng tháng" : "월간 장부"}
            >
              {loading ? (
                <p className={styles.empty}>
                  {vi ? "Đang tải sổ..." : "장부를 불러오는 중입니다."}
                </p>
              ) : groups.length === 0 ? (
                <p className={styles.empty}>
                  {vi
                    ? "Không có giao dịch phù hợp."
                    : "조건에 맞는 내역이 없습니다."}
                </p>
              ) : (
                <>
                  {pastGroups.length ? (
                    <section className={styles.dateGroup}>
                      <button
                        type="button"
                        className={styles.dateHeader}
                        aria-expanded={historyOpen}
                        aria-controls="ledger-history-panel"
                        onClick={() => setHistoryExpanded((value) => !value)}
                      >
                        <strong>{vi ? "Lịch sử trước đó" : "지난 내역"}</strong>
                        <span>
                          {formatDateRange(pastGroups[0].date, pastGroups.at(-1)!.date, lang)}
                          {" · "}
                          {pastGroups.length}{vi ? " ngày" : "일"}
                        </span>
                        <i
                          aria-hidden
                          className={
                            historyOpen
                              ? styles.dateChevronOpen
                              : styles.dateChevron
                          }
                        >
                          ›
                        </i>
                      </button>
                      {historyOpen ? (
                        <div id="ledger-history-panel" className={styles.historyPanel}>
                          {pastGroups.map(renderDateGroup)}
                        </div>
                      ) : null}
                    </section>
                  ) : null}
                  {remainingGroups.map(renderDateGroup)}
                </>
              )}
            </section>
          </>
        ) : loading ? (
          <p className={styles.empty}>
            {vi ? "Đang tải sổ..." : "장부를 불러오는 중입니다."}
          </p>
        ) : null}
        {data && data.month === month ? (
          <aside className={styles.balanceBar}>
            <div className={styles.balanceInner}>
              <button
                type="button"
                className={styles.balanceToggle}
                aria-expanded={balanceExpanded}
                aria-controls="ledger-current-balance-detail"
                onClick={() => setBalanceExpanded((value) => !value)}
              >
                <span className={styles.balanceViewLabel}>
                  {vi
                    ? `Tiền hiện có (T${Number(month.slice(5, 7))})`
                    : `현재 보유금 (${Number(month.slice(5, 7))}월)`}
                  {data.fundsView.mode !== "live" ? (
                    <small className={styles.balanceViewBadge}>
                      {data.fundsView.mode === "closed_snapshot"
                        ? vi ? "Đã chốt" : "마감"
                        : vi ? "Chưa chốt" : "미마감"}
                    </small>
                  ) : null}
                </span>
                <strong>{money(currentBalanceTotal)}</strong>
                <i aria-hidden>{balanceExpanded ? "⌃" : "⌄"}</i>
              </button>
              {balanceExpanded ? <div className={styles.balanceDetail} id="ledger-current-balance-detail">
                <div className={styles.balanceAccounts}>
                  {primaryBalanceAccounts.map(renderBalanceCard)}
                  {personalBalanceAccounts.length > 0 ? (
                    <div className={styles.personalAccounts}>
                      {personalBalanceAccounts.map(renderBalanceCard)}
                    </div>
                  ) : null}
                </div>
              </div> : null}
            </div>
          </aside>
        ) : null}
        {manualOpen && data ? (
          <ManualEntrySheet
            lang={lang}
            data={data}
            investments={activeInvestments}
            month={month}
            saving={saving}
            setSaving={setSaving}
            onClose={() => setManualOpen(false)}
            returnFocusRef={addButtonRef}
            onSaved={async () => {
              setManualOpen(false);
              await load();
            }}
          />
        ) : null}
        {reopenSheetOpen && closed ? (
          <BarSheet
            kind="bottom"
            topAligned
            comfortableTop
            title={vi ? `Mở lại sổ tháng ${Number(month.slice(5, 7))}` : `${Number(month.slice(5, 7))}월 마감 다시 열기`}
            closeLabel={vi ? "Đóng" : "닫기"}
            saving={reopening}
            onClose={() => { setReopenSheetOpen(false); setReopenReason(""); setReopenError(""); }}
            footer={<div className={styles.reopenFooter}>
              <button type="button" disabled={reopening || !reopenReason.trim()}
                onClick={() => void reopenMonth()} style={{ ...primaryButtonStyle, width: "100%" }}>
                {reopening ? vi ? "Đang mở lại…" : "처리 중…" : vi ? "Mở lại để kiểm tra" : "재검토 위해 마감 열기"}
              </button>
              <button type="button" disabled={reopening}
                onClick={() => { setReopenSheetOpen(false); setReopenReason(""); setReopenError(""); }}
                style={{ ...secondaryButtonStyle, width: "100%" }}>
                {vi ? "Hủy" : "취소"}
              </button>
            </div>}>
            <p className={styles.reopenHelp}>
              {vi ? "Mở lại tháng này sẽ cho phép sửa sổ." : "마감을 다시 열면 이 월의 장부를 수정할 수 있습니다."}
            </p>
            <p className={styles.reopenHelp}>
              {vi ? "Bản chốt trước đó được lưu an toàn trong lịch sử." : "기존 마감본은 이력으로 안전하게 보존됩니다."}
            </p>
            <label className={styles.reopenReasonLabel} htmlFor="ledger-reopen-reason">
              {vi ? "Lý do mở lại" : "재오픈 사유"}
            </label>
            <textarea id="ledger-reopen-reason" className={styles.reopenReason}
              value={reopenReason} onChange={(event) => setReopenReason(event.target.value)}
              required rows={3} />
            {reopenError ? <p className={styles.error} role="alert">{reopenError}</p> : null}
          </BarSheet>
        ) : null}
        {closeSheetOpen && monthCloseState?.month === month &&
          (monthCloseState.state === "reopened" || (monthCloseState.state === "open" && month < businessMonth)) ? (
          <MonthCloseSheet key={month} month={month} revision={monthCloseState.revision} vi={vi}
            onClose={() => setCloseSheetOpen(false)} returnFocusRef={closeButtonRef}
            onClosed={async () => {
              setCloseSheetOpen(false);
              const fresh = await load();
              if (fresh) setNotice(vi ? `Đã chốt sổ tháng ${Number(month.slice(5, 7))}.` : `${Number(month.slice(5, 7))}월 장부 마감이 완료되었습니다.`);
            }} />
        ) : null}
        {selected?.systemDisplay?.kind === "reserve" ? (
          <ReserveEntryDetailSheet
            lang={lang}
            entry={selected}
            onClose={() => setSelected(null)}
          />
        ) : selected ? (
          <EntryDetailSheet
            lang={lang}
            entry={selected}
            partnersByParty={partnerByLedgerParty}
            partners={data?.partners ?? []}
            accounts={data?.accounts ?? []}
            categories={data?.categories ?? []}
            candidateDraft={candidateDraft}
            setCandidateDraft={setCandidateDraft}
            editCandidate={editCandidate}
            resolveCandidate={resolveCandidate}
            saving={saving}
            message={detailMessage}
            posDetail={posDetail}
            closed={closed}
            onConfirmedEdited={async (transactionId, successMessage) => {
              setNotice(successMessage ?? (vi ? "Đã cập nhật giao dịch." : "거래를 수정했습니다."));
              const fresh = await load(undefined, { silent: true });
              const refreshed = fresh?.entries.find((entry) =>
                entry.transactionId === transactionId ||
                entry.items.some((item) => item.transactionId === transactionId),
              );
              if (refreshed) setSelected(refreshed);
            }}
            onAdvanceCancelled={async () => {
              setSelected(null);
              await load();
              setNotice(vi ? "Đã hủy ứng lương và hoàn tiền vào tài khoản." : "가불을 취소하고 출금 계정 잔액을 복구했습니다.");
            }}
            onClose={() => {
              setSelected(null);
              setCandidateDraft(null);
            }}
          />
        ) : null}
        {payableParty && data && payables?.month === month && payableParty.viewMonth === month ? (
          month === currentMonth()
            ? <PayablePartySheet key={`${month}:${payableParty.partyId}`} lang={lang} party={payableParty} accounts={businessAccounts} onClose={() => setPayableParty(null)} onPaid={async () => { setPayableParty(null); await load(); setNotice(vi ? "Đã thanh toán các ngày đã chọn." : "선택 일자의 미납금을 결제했습니다."); }} />
            : <HistoricalPayablePartySheet key={`${month}:${payableParty.partyId}`} lang={lang} month={month} party={payableParty} onClose={() => setPayableParty(null)} />
        ) : null}
      </main>
    </Container>
  );
}

export default function LedgerEntriesPage() {
  return <Suspense fallback={<Container><main>장부 불러오는 중...</main></Container>}>
    <LedgerEntriesContent />
  </Suspense>;
}

function EntryDetailSheet({
  lang,
  entry,
  partnersByParty,
  partners,
  accounts,
  categories,
  candidateDraft,
  setCandidateDraft,
  editCandidate,
  resolveCandidate,
  saving,
  message,
  posDetail,
  closed,
  onConfirmedEdited,
  onAdvanceCancelled,
  onClose,
}: {
  lang: "ko" | "vi";
  entry: LedgerEntry;
  partnersByParty: ReadonlyMap<number, Partner>;
  partners: Partner[];
  accounts: Account[];
  categories: Category[];
  candidateDraft: CandidateDraft | null;
  setCandidateDraft: (draft: CandidateDraft | null) => void;
  editCandidate: (item: LedgerEntryItem) => void;
  resolveCandidate: () => Promise<void>;
  saving: boolean;
  message: string;
  posDetail: Record<string, unknown> | null;
  closed: boolean;
  onConfirmedEdited: (transactionId: number, successMessage?: string) => Promise<void>;
  onAdvanceCancelled: () => Promise<void>;
  onClose: () => void;
}) {
  const vi = lang === "vi";
  // Only ledger-created advances can be cancelled, and only here: the payroll
  // adjustment and an append-only cash reversal are written together.
  const cancellableAdvance = entry.ledgerPayrollAdvance != null && !entry.ledgerPayrollAdvance.cancelled && entry.transactionId != null;
  const [advanceCancelReason,setAdvanceCancelReason]=useState<string|null>(null),[advanceCancelError,setAdvanceCancelError]=useState(""),[advanceCancelling,setAdvanceCancelling]=useState(false);
  const [manualDisplayOpen, setManualDisplayOpen] = useState(false);
  const [manualDisplaySaving, setManualDisplaySaving] = useState(false);
  async function cancelAdvance(){
    if(!cancellableAdvance||advanceCancelReason==null||!advanceCancelReason.trim())return;
    setAdvanceCancelling(true);setAdvanceCancelError("");
    try{
      const response=await fetch(`/api/admin/ledger/payroll-advances/${entry.transactionId}/cancel`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({reason:advanceCancelReason.trim()})}),body=await response.json();
      if(!response.ok)throw new Error(body.code??"PAYROLL_ADVANCE_CANCEL_FAILED");
      setAdvanceCancelReason(null);
      await onAdvanceCancelled();
    }catch(cause){setAdvanceCancelError(`${vi?"Không thể hủy ứng lương.":"가불을 취소하지 못했습니다."} ${(cause as Error).message}`)}
    finally{setAdvanceCancelling(false)}
  }
  const confirmedInventory = entry.drilldown === "inventory" && entry.status === "confirmed";
  const confirmedMeal = entry.drilldown === "meal" && entry.status === "confirmed";
  const [editMode,setEditMode]=useState(false),[editDraft,setEditDraft]=useState<ConfirmedEditDraft|null>(null),[editError,setEditError]=useState(""),[editSaving,setEditSaving]=useState(false);
  const [mealDraft,setMealDraft]=useState<MealAdjustDraft|null>(null),[mealError,setMealError]=useState(""),[mealNotice,setMealNotice]=useState("");
  const payments = (posDetail?.payments ?? []) as Array<
    Record<string, unknown>
  >;
  return (
    <BarSheet
      kind="full"
      compact
      topAligned
      comfortableTop
      title={vi ? "Chi tiết giao dịch" : "거래 상세"}
      titleAside={formatDate(entry.businessDate, lang)}
      closeLabel={vi ? "Đóng" : "닫기"}
      saving={saving||editSaving||advanceCancelling||manualDisplaySaving}
      onClose={onClose}
      footer={
        <div className={styles.detailFooter}>
          {entry.editableManualDisplay ? <button type="button" disabled={saving || manualDisplaySaving || closed} onClick={() => setManualDisplayOpen(value => !value)} style={{ ...primaryButtonStyle, width: "100%" }}>{manualDisplayOpen ? (vi ? "Đóng chỉnh sửa" : "수정 닫기") : (vi ? "Sửa" : "수정")}</button> : null}
          {cancellableAdvance ? <button type="button" disabled={saving||advanceCancelling||closed} onClick={()=>{setAdvanceCancelReason(value=>value==null?"":null);setAdvanceCancelError("")}} style={{...(advanceCancelReason==null?dangerButtonStyle:secondaryButtonStyle),width:"100%"}}>{advanceCancelReason==null?(vi?"Hủy ứng lương":"가불 취소"):(vi?"Đóng hủy ứng lương":"가불 취소 닫기")}</button>:null}
          {confirmedInventory ? <button type="button" disabled={saving||editSaving||closed} onClick={()=>{setEditMode(value=>!value);setEditDraft(null);setEditError("")}} style={{...primaryButtonStyle,width:"100%"}}>{editMode?(vi?"Kết thúc chỉnh sửa":"수정 종료"):(vi?"Sửa":"수정")}</button>:null}
          {confirmedMeal ? <button type="button" disabled={saving||editSaving||closed} onClick={()=>{setMealDraft(value=>value?null:{finalAmount:String(entry.effectiveAmount??entry.amount),reason:""});setMealError("");setMealNotice("")}} style={{...primaryButtonStyle,width:"100%"}}>{mealDraft?(vi?"Đóng chỉnh sửa":"수정 닫기"):(vi?"Sửa":"수정")}</button>:null}
          <button
            type="button"
            disabled={saving||editSaving}
            onClick={onClose}
            style={{ ...secondaryButtonStyle, width: "100%" }}
          >
            {vi ? "Đóng" : "닫기"}
          </button>
        </div>
      }
    >
      <div className={styles.detailSummary}>
        <span className={styles.detailLeft}>
          <EntryDisplayBadge entry={entry} lang={lang} />
          <span className={styles.detailEmoji} aria-hidden="true">{entryDisplayEmoji(entry, partnersByParty)}</span>
          <span className={styles.detailTitleText} title={entryDisplayTitle(entry, lang)}>
            <span className={styles.detailTitleLine}>
              <strong>{compactEntryListTitle(entryDisplayTitle(entry, lang))}</strong>
              <EntryFlags entry={entry} lang={lang} />
            </span>
            {entryMeta(entry, lang) ? <span> · {entryMeta(entry, lang)}</span> : null}
          </span>
        </span>
        <span className={styles.detailPayment}>
          <span
            className={`${styles.accountBadge} ${isPayableAccount(entry.accountName) ? styles.accountBadgePayable : ""} ${entry.systemDisplay?.kind === "cardSettlementDeposit" ? styles.accountBadgeCardSettlement : ""} ${entry.systemDisplay?.kind === "accountTransfer" ? styles.accountBadgeAccountTransfer : ""}`}
            title={entry.accountName ?? (vi ? "Không có tài khoản" : "계정 없음")}
          >
            {accountBadgeLabel(entry.accountName, lang, entry)}
          </span>
          <strong className={`${styles.detailAmount} ${isPayrollPaymentOutflow(entry) ? styles.amountExpense : ""}`}>{entryDisplayAmountSign(entry)}{money(entryDisplayAmount(entry))}</strong>
        </span>
      </div>
      {entryStatusReason(entry, lang) ? <p className={styles.entryStatusReason}>{entryStatusReason(entry, lang)}</p> : null}
      {manualDisplayOpen && entry.editableManualDisplay && entry.transactionId != null ? (
        <ManualDisplayEditor
          lang={lang}
          transactionId={entry.transactionId}
          originalTitle={entryDisplayTitle(entry, lang)}
          originalMemo={entry.memo ?? ""}
          originalAmount={entry.amount}
          amountEditable={!entry.paymentTransaction}
          closed={closed}
          onSavingChange={setManualDisplaySaving}
          onConfirmedEdited={onConfirmedEdited}
          onClose={() => setManualDisplayOpen(false)}
        />
      ) : null}
      {entry.systemDisplay?.kind === "cardSettlementDifference" ? (
        <div className={styles.candidateEditor}>
          <p>{vi
            ? "Giao dịch này được xác nhận theo cách đối soát thẻ cũ: chênh lệch giữa doanh số thẻ đã khớp và tiền thực nhận."
            : "과거 카드정산 방식에서 카드매출 매칭금액과 실제 입금액의 차액으로 확정된 기록입니다."}</p>
          <dl className={styles.cardLegacyFacts}>
            {entry.systemDisplay.matchedGrossAmount != null ? <div><dt>{vi ? "Doanh số thẻ đối soát" : "정산 대상 카드매출"}</dt><dd>{money(entry.systemDisplay.matchedGrossAmount)}</dd></div> : null}
            {entry.systemDisplay.depositAmount != null ? <div><dt>{vi ? "Tiền thực nhận" : "실제 입금"}</dt><dd>{money(entry.systemDisplay.depositAmount)}</dd></div> : null}
            {entry.systemDisplay.differenceAmount != null ? <div><dt>{vi ? "Chênh lệch" : "정산차액"}</dt><dd>{money(entry.systemDisplay.differenceAmount)}</dd></div> : null}
            {entry.systemDisplay.matchedGrossAmount != null && entry.systemDisplay.matchedGrossAmount > 0 && entry.systemDisplay.differenceAmount != null ? <div><dt>{vi ? "Tỷ lệ chênh lệch" : "차이율"}</dt><dd>{(entry.systemDisplay.differenceAmount / entry.systemDisplay.matchedGrossAmount * 100).toFixed(2)}%</dd></div> : null}
          </dl>
        </div>
      ) : null}
      {cancellableAdvance && advanceCancelReason != null ? (
        <div className={styles.candidateEditor}>
          <h3>{vi ? "Hủy ứng lương" : "가불 취소"}</h3>
          <p className={styles.editorHelp}>{vi
            ? `Hủy khoản ứng ${money(entry.amount)}: khoản trừ lương bị hủy và tiền được hoàn lại vào tài khoản chi. Giao dịch gốc vẫn được lưu.`
            : `${money(entry.amount)} 가불을 취소하면 급여 차감이 취소되고 출금 계정 잔액이 복구됩니다. 원본 거래는 기록으로 남습니다.`}</p>
          <BarField label={`📝 ${vi ? "Lý do hủy" : "취소 사유"}`} required compact>
            {({ id }) => <input id={id} data-advance-cancel-field="reason" required value={advanceCancelReason} onChange={(event) => setAdvanceCancelReason(event.target.value)} style={keepingInputStyle} />}
          </BarField>
          {advanceCancelError ? <p className={styles.error} role="alert">{advanceCancelError}</p> : null}
          <button type="button" disabled={advanceCancelling || closed || !advanceCancelReason.trim()} onClick={() => void cancelAdvance()} style={{ ...dangerButtonStyle, width: "100%" }}>
            {advanceCancelling ? (vi ? "Đang hủy…" : "취소 중…") : (vi ? "Xác nhận hủy ứng lương" : "가불 취소 확정")}
          </button>
        </div>
      ) : null}
      {message && !candidateDraft ? (
        <p className={styles.error} role="alert">
          {message}
        </p>
      ) : null}
      {entry.drilldown === "inventory" ? (
        <div className={styles.itemList}>
          {entry.items.map((item) => (
            <article
              key={item.candidateId ?? item.transactionId}
            >
              <span className={styles.itemDescription}>
                  <strong>📦 {lang === "vi" ? item.nameVi || item.name : item.name}</strong>
                  <small>{[lang === "vi" ? item.inventoryCategoryVi || item.inventoryCategory : item.inventoryCategory, item.unit].filter(Boolean).join(" · ")}</small>
                  {item.quantity == null
                    ? ""
                    : ` · ${item.quantity.toLocaleString("ko-KR")}`}
                  {item.unitPrice == null ? "" : ` × ${money(item.unitPrice)}`}
              </span>
              <span className={styles.itemAmount}>
                {item.displayTime ? <small>{item.displayTime}</small> : null}
                <b>{money(item.amount)}</b>
              </span>
              {entry.status === "pending" || (confirmedInventory && editMode) ? (
                <button
                  className={styles.itemAction}
                  type="button"
                  onClick={() => entry.status === "pending" ? editCandidate(item) : setEditDraft({item,paymentMode:item.paymentMode??"immediate",categoryId:String(item.categoryId??""),fundAccountId:String(item.fundAccountId??""),dueDate:item.dueDate??"",amount:String(item.amount),memo:item.memo??"",reason:""})}
                >
                  {vi ? "Sửa" : "수정"}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      {payments.length ? (
        <div className={styles.itemList}>
          {payments.map((payment, index) => (
            <article key={String(payment.paymentId ?? index)}>
              <div className={styles.itemLine}>
                <span className={styles.itemDescription}>
                  <strong>🧾{" "}
                  {String(
                    payment.refNo ??
                      `${vi ? "Hóa đơn" : "영수증"} ${index + 1}`,
                  )}
                  </strong>
                  {" · 💳 "}
                  {String(
                    payment.paymentMethod ??
                      (vi ? "Phương thức thanh toán" : "결제수단"),
                  )}
                </span>
                <b>{money(Number(payment.paymentAmount ?? 0))}</b>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {confirmedMeal ? <div className={styles.itemList}>
        <article><span className={styles.itemDescription}>{vi?"Số tiền tổng hợp tự động":"자동집계 원본"}</span><b>{money(entry.originalAmount??entry.amount)}</b></article>
        <article><span className={styles.itemDescription}>{vi?"Tổng điều chỉnh thủ công":"수동 정정 합계"}</span><b>{(entry.adjustmentAmount??0)>0?"+":""}{money(entry.adjustmentAmount??0)}</b></article>
        <article><span className={styles.itemDescription}><strong>{vi?"Số tiền hiện áp dụng":"현재 반영 금액"}</strong></span><b>{money(entry.effectiveAmount??entry.amount)}</b></article>
        {entry.requiresCorrection ? <article><span className={styles.itemDescription}><strong>{vi?"Nguồn mới nhất · cần điều chỉnh":"최신 원천 · 정정 필요"}</strong></span><b>{money(entry.sourceAmount??0)}</b></article>:null}
      </div>:null}
      {candidateDraft ? (
        <div className={styles.candidateEditor}>
          <h3>{candidateDraft.item.name}</h3>
          <BarSegmentedControl
            scrollable
            label={vi ? "Phương thức xử lý" : "처리 방식"}
            value={candidateDraft.resolution}
            disabled={saving}
            onChange={(resolution) =>
              setCandidateDraft({ ...candidateDraft, resolution })
            }
            options={[
              {
                value: "immediate",
                label: vi ? "Thanh toán ngay" : "즉시 결제",
              },
              {
                value: "payable",
                label: vi ? "Ghi nhận công nợ" : "미지급 등록",
              },
              {
                value: "verification_pending",
                label: vi ? "Chưa xác minh thanh toán" : "결제 미확인",
              },
            ]}
          />
          {entry.partyId == null && (candidateDraft.resolution === "payable" || candidateDraft.resolution === "verification_pending") ? (
            <BarField label={vi ? "Đối tác" : "거래처"} required compact>
              {({ id }) => <PartnerSelect id={id} partners={partners} lang={lang} required disabled={saving} value={candidateDraft.partyId}
                onChange={(partyId) => setCandidateDraft({ ...candidateDraft, partyId })} />}
            </BarField>
          ) : null}
          <div
            className={`${styles.candidateFields} ${candidateDraft.resolution === "immediate" ? "" : styles.candidateSingle}`}
          >
            <BarField label={vi ? "Danh mục chi phí" : "비용 카테고리"} required compact>
              {({ id }) => (
                <select
                  id={id}
                  value={candidateDraft.categoryId}
                  onChange={(event) =>
                    setCandidateDraft({
                      ...candidateDraft,
                      categoryId: event.target.value,
                    })
                  }
                  style={keepingInputStyle}
                >
                  {inventoryManualCategoryOptions(categories, candidateDraft.categoryId)
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {manualExpenseCategoryLabel(row.name, lang)}
                      </option>
                    ))}
                </select>
              )}
            </BarField>
            {candidateDraft.resolution === "immediate" ? (
              <BarField
                label={vi ? "Tài khoản thanh toán thực tế" : "실제 지급 계정"}
                required
                compact
              >
                {({ id }) => (
                  <select
                    id={id}
                    value={candidateDraft.fundAccountId}
                    onChange={(event) =>
                      setCandidateDraft({
                        ...candidateDraft,
                        fundAccountId: event.target.value,
                      })
                    }
                    style={keepingInputStyle}
                  >
                    <option value="">{vi ? "Chọn" : "선택"}</option>
                    {accounts
                      .filter((row) => row.is_active && row.type !== "card_clearing")
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.display_name}
                        </option>
                      ))}
                  </select>
                )}
              </BarField>
            ) : null}
          </div>
          <BarField label={vi ? "Ghi chú" : "메모"} compact>
            {({ id }) => (
              <input
                id={id}
                value={candidateDraft.memo}
                onChange={(event) =>
                  setCandidateDraft({
                    ...candidateDraft,
                    memo: event.target.value,
                  })
                }
                style={keepingInputStyle}
              />
            )}
          </BarField>
          <p className={styles.editorHelp}>
            {vi
              ? "Thay đổi này chỉ áp dụng cho giao dịch sổ hiện tại và không thay đổi thiết lập thanh toán mặc định của đối tác."
              : "이 변경은 해당 장부 내역에만 적용되며 거래처 기본 결제설정은 변경하지 않습니다."}
          </p>
          {message ? <p role="alert" className={styles.error}>{message}</p> : null}
          <button
            type="button"
            disabled={
              saving ||
              !candidateDraft.categoryId ||
              (candidateDraft.resolution === "immediate" &&
                !candidateDraft.fundAccountId)
            }
            onClick={() => void resolveCandidate()}
            style={{ ...primaryButtonStyle, width: "100%" }}
          >
            {saving
              ? vi
                ? "Đang ghi sổ…"
                : "반영 중…"
              : vi
                ? "Ghi mặt hàng này vào sổ"
                : "이 품목 장부에 반영"}
          </button>
        </div>
      ) : null}
      {editDraft ? <ConfirmedInventoryEditor lang={lang} draft={editDraft} setDraft={setEditDraft} accounts={accounts} categories={categories} saving={editSaving} error={editError} onSave={async()=>{
        if(!editDraft.item.transactionId)return;
        setEditSaving(true);setEditError("");
        try{const response=await fetch(`/api/admin/ledger/transactions/${editDraft.item.transactionId}/edit`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({paymentMode:editDraft.paymentMode,categoryId:Number(editDraft.categoryId),fundAccountId:editDraft.paymentMode==="immediate"?Number(editDraft.fundAccountId):null,dueDate:editDraft.paymentMode==="payable"?(editDraft.dueDate||null):null,amount:editDraft.amount,memo:editDraft.memo||null,reason:editDraft.reason})}),body=await response.json();if(!response.ok)throw new Error(body.code??"INVENTORY_EDIT_FAILED");setEditDraft(null);await onConfirmedEdited(Number(body.result.transactionId))}catch(cause){setEditError(`${vi?"Không thể sửa giao dịch.":"거래를 수정하지 못했습니다."} ${(cause as Error).message}`)}finally{setEditSaving(false)}
      }}/>:null}
      {mealDraft ? <MealAdjustmentEditor lang={lang} draft={mealDraft} setDraft={setMealDraft} saving={editSaving} error={mealError} onSave={async()=>{
        if(!mealDraft.reason.trim()){
          setMealError(vi?"Vui lòng nhập lý do chỉnh sửa.":"수정 사유를 입력해주세요.");
          return;
        }
        if(!entry.transactionId)return;
        setEditSaving(true);setMealError("");
        let successMessage: string | undefined;
        try{const response=await fetch(`/api/admin/ledger/transactions/${entry.transactionId}/meal-adjust`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({finalAmount:mealDraft.finalAmount,reason:mealDraft.reason})}),body=await response.json();if(!response.ok)throw new Error(body.code??"MEAL_ADJUST_FAILED");
          successMessage=body.result?.status==="unchanged"
            ?(vi?"Số tiền giống với số tiền hiện đang ghi nhận. Không tạo thêm giao dịch điều chỉnh.":"현재 반영 금액과 동일합니다. 추가 정정은 생성하지 않았습니다.")
            :body.result?.status==="reviewed"
              ?(vi?"Đã kiểm tra thay đổi dữ liệu nguồn và giữ nguyên số tiền hiện đang ghi nhận. Không tạo thêm giao dịch điều chỉnh.":"원천 변경을 검토하고 현재 반영 금액을 유지했습니다. 추가 정정은 생성하지 않았습니다.")
              :(vi?"Đã điều chỉnh tiền ăn.":"식대를 정정했습니다.");
          setMealDraft(null);setMealNotice(successMessage);
        }catch(cause){const code=(cause as Error).message;setMealError(code==="ORIGINAL_MONTH_CLOSED"?(vi?"Không thể sửa giao dịch của tháng đã khóa.":"마감된 월의 거래는 일반 수정할 수 없습니다."):`${vi?"Không thể sửa tiền ăn.":"식대를 수정하지 못했습니다."} ${code}`)}finally{setEditSaving(false)}
        if(successMessage)await onConfirmedEdited(entry.transactionId,successMessage);
      }}/>:null}
      {confirmedMeal&&mealNotice?<p role="status" className={styles.policyNote}>{mealNotice}</p>:null}
      {confirmedMeal&&closed?<p className={styles.policyNote}>{vi?"Không thể sửa giao dịch của tháng đã khóa.":"마감된 월의 거래는 일반 수정할 수 없습니다."}</p>:null}
      {entry.status === "confirmed" && entry.origin === "auto" ? (
        <p className={styles.policyNote}>
          {vi
            ? "Ảnh chụp dữ liệu nguồn được giữ nguyên. Thay đổi trong tháng đã khóa được xử lý theo chính sách điều chỉnh sổ hiện hành."
            : "원본 snapshot은 보존됩니다. 마감된 월의 변경은 기존 장부 정정 정책으로 처리됩니다."}
        </p>
      ) : null}
      {entry.memo?.trim() ? (
        <details className={styles.detailMemo}>
          <summary className={styles.detailMemoLabel}>{vi ? "Xem toàn bộ ghi chú" : "메모 전체 보기"}</summary>
          <p className={styles.detailMemoText}>{entry.memo}</p>
        </details>
      ) : null}
      {entry.editableManualDisplay && entry.transactionId != null ? (
        <ManualDisplayHistory
          key={`${entry.transactionId}:${entryDisplayTitle(entry, lang)}:${entry.memo ?? ""}:${entry.amount}`}
          transactionId={entry.transactionId}
          lang={lang}
        />
      ) : null}
    </BarSheet>
  );
}

function MealAdjustmentEditor({lang,draft,setDraft,saving,error,onSave}:{lang:"ko"|"vi";draft:MealAdjustDraft;setDraft:(draft:MealAdjustDraft|null)=>void;saving:boolean;error:string;onSave:()=>Promise<void>}){
  const vi=lang==="vi";
  return <LedgerEditShell lang={lang} title={vi?"Sửa tiền ăn nhân viên":"직원 식대 수정"}
    saving={saving} disabled={!draft.finalAmount} error={error}
    onSave={()=>void onSave()} onCancel={()=>setDraft(null)}>
    <BarField label={vi?"Số tiền ăn cuối cùng":"최종 식대 금액"} required compact>{({id})=><input id={id} inputMode="decimal" value={formatLedgerDecimalAmount(draft.finalAmount)} onChange={event=>setDraft({...draft,finalAmount:sanitizeLedgerDecimalAmount(event.target.value)})} style={keepingInputStyle}/>}</BarField>
    <BarField label={vi?"Lý do chỉnh sửa":"수정 사유"} required compact>{({id})=><input id={id} value={draft.reason} onChange={event=>setDraft({...draft,reason:event.target.value})} style={keepingInputStyle} placeholder={vi?"Ví dụ: thêm 1 nhân viên đến muộn":"예: 18시 이후 추가 출근 1명"}/>}</BarField>
    <p className={styles.editorHelp}>{vi?"Hệ thống tự tính phần chênh lệch và điều chỉnh tiền mặt cửa hàng.":"차액과 매장 현금 조정은 자동으로 계산됩니다."}</p>
  </LedgerEditShell>
}

function ConfirmedInventoryEditor({lang,draft,setDraft,accounts,categories,saving,error,onSave}:{lang:"ko"|"vi";draft:ConfirmedEditDraft;setDraft:(draft:ConfirmedEditDraft|null)=>void;accounts:Account[];categories:Category[];saving:boolean;error:string;onSave:()=>Promise<void>}){
  const vi=lang==="vi",paid=(draft.item.paidAmount??0)>0;
  return <LedgerEditShell lang={lang} title={draft.item.name} saving={saving}
    disabled={paid||!draft.categoryId||!draft.amount||!draft.reason.trim()||(draft.paymentMode==="immediate"&&!draft.fundAccountId)}
    error={error} onSave={()=>void onSave()} onCancel={()=>setDraft(null)}>
    <BarSegmentedControl label={vi?"Phân loại thanh toán":"결제 구분"} value={draft.paymentMode} disabled={saving||paid} onChange={paymentMode=>setDraft({...draft,paymentMode})} options={[{value:"immediate",label:vi?"Trả trước":"선결제"},{value:"payable",label:vi?"Trả sau":"후불"}]}/>
    {paid?<p className={styles.error}>{vi?"Khoản công nợ đã được thanh toán một phần hoặc toàn bộ nên không thể sửa.":"일부 또는 전액 결제된 미납 거래는 수정할 수 없습니다."}</p>:null}
    <div className={styles.candidateFields}><BarField label={vi?"Danh mục":"카테고리"} required compact>{({id})=><select id={id} value={draft.categoryId} onChange={event=>setDraft({...draft,categoryId:event.target.value})} style={keepingInputStyle}>{inventoryManualCategoryOptions(categories,draft.categoryId).map(row=><option key={row.id} value={row.id}>{manualExpenseCategoryLabel(row.name,lang)}</option>)}</select>}</BarField><BarField label={vi?"Số tiền":"금액"} required compact>{({id})=><input id={id} inputMode="decimal" value={formatLedgerDecimalAmount(draft.amount)} onChange={event=>setDraft({...draft,amount:sanitizeLedgerDecimalAmount(event.target.value)})} style={keepingInputStyle}/>}</BarField></div>
    {draft.paymentMode==="immediate"?<div className={styles.candidateSingle}><AccountField lang={lang} label={`🏦 ${vi?"Tài khoản chi":"출금 계정"}`} value={draft.fundAccountId} setValue={fundAccountId=>setDraft({...draft,fundAccountId})} accounts={accounts.filter(row=>row.is_active&&row.is_business_fund&&row.type!=="card_clearing")}/></div>:<div className={styles.candidateSingle}><BarField label={vi?"Ngày đến hạn":"지급 기한"} compact>{({id})=><input id={id} type="date" value={draft.dueDate} onChange={event=>setDraft({...draft,dueDate:event.target.value})} style={keepingInputStyle}/>}</BarField></div>}
    <BarField label={vi?"Ghi chú":"메모"} compact>{({id})=><input id={id} value={draft.memo} onChange={event=>setDraft({...draft,memo:event.target.value})} style={keepingInputStyle}/>}</BarField>
    <BarField label={vi?"Lý do chỉnh sửa":"수정 사유"} required compact>{({id})=><input id={id} required value={draft.reason} onChange={event=>setDraft({...draft,reason:event.target.value})} style={keepingInputStyle}/>}</BarField>
  </LedgerEditShell>
}

function PayableMonthTotals({summary,vi}:{summary?:PayablePeriodSummary;vi:boolean}) {
  const fields = [["openingOutstanding",vi?"↪️ Nợ chuyển tháng trước":"↪️ 전월 이월 미납"],["periodPurchases",vi?"📦 Phát sinh tháng":"📦 당월 외상 발생"],["periodPayments",vi?"💸 Thanh toán tháng":"💸 당월 지급"],["closingOutstanding",vi?"🧾 Công nợ cuối tháng":"🧾 월말 미납"]] as const;
  return <dl className={styles.payableMonthTotals}>{fields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{summary?money(summary[key]):"-"}</dd></div>)}</dl>;
}

function PayableDateGroups({rows,lang,selectedDates,onSelectDate}:{rows:readonly PayableRow[];lang:"ko"|"vi";selectedDates?:ReadonlySet<string>;onSelectDate?:(date:string)=>void}) {
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
  const selectable=Boolean(onSelectDate);
  const groups=useMemo(()=>groupPayableRows(rows,!selectable),[rows,selectable]);
  const vi=lang==="vi";
  return <div className={`${styles.payableDates} ${!selectable ? styles.payableDatesReadOnly : ""}`}>{groups.map(group=>{
    const open=expanded.has(group.businessDate);
    const paidReadOnly=!selectable&&group.settlementStatus==="paid";
    return <article key={group.businessDate}><div className={`${styles.payableDateRow} ${!selectable ? styles.payableDateRowReadOnly : ""}`}>
      {selectable&&onSelectDate?<input type="checkbox" checked={selectedDates?.has(group.businessDate)??false} aria-label={`${formatDate(group.businessDate,lang)} ${vi?"chọn":"선택"}`} onChange={()=>onSelectDate(group.businessDate)}/>:null}
      <button type="button" aria-expanded={open} onClick={()=>setExpanded(current=>{const next=new Set(current);if(next.has(group.businessDate))next.delete(group.businessDate);else next.add(group.businessDate);return next})}>
        <span className={styles.payableDateLabel}><span>📅 {formatDate(group.businessDate,lang)}</span>{paidReadOnly?<em className={styles.payablePaidBadge}>{vi?"Đã thanh toán":"결제완료"}</em>:null}</span><small>{group.rows.length}{vi?" khoản":"건"}</small>{paidReadOnly?null:<strong>{money(group.total)}</strong>}<i aria-hidden>⌄</i>
      </button>
    </div>{open?<div className={styles.payableItems}>{group.rows.map(row=><span key={row.id}><em>↳ {payableItemLabel(row,vi)}</em>{paidReadOnly?null:<b>{money(row.outstandingAmount)}</b>}</span>)}</div>:null}</article>
  })}</div>;
}

// Month accordion around the existing read-only date accordion. Months run
// oldest → newest like the dates inside them; only the newest returned month
// starts open. Rows, counts and amounts are passed through as-is.
function PayableMonthGroups({rows,lang}:{rows:readonly PayableRow[];lang:"ko"|"vi"}) {
  const groups=useMemo(()=>groupPayableRowsByMonth(rows),[rows]);
  const [toggled,setToggled]=useState<Set<string>>(()=>new Set());
  const vi=lang==="vi",latest=latestPayableMonth(groups);
  return <div className={styles.payableMonthGroups}>{groups.map(group=>{
    const open=(group.month===latest)!==toggled.has(group.month);
    const [year,monthNumber]=group.month.split("-").map(Number);
    const label=!group.month?(vi?"Không rõ ngày":"날짜 미상"):vi?`Tháng ${monthNumber}/${year}`:`${year}년 ${monthNumber}월`;
    return <section key={group.month} className={styles.payableMonthGroup}>
      <button type="button" className={styles.payableMonthHeader} aria-expanded={open} onClick={()=>setToggled(current=>{const next=new Set(current);if(next.has(group.month))next.delete(group.month);else next.add(group.month);return next})}>
        <span className={styles.payableMonthLabel}><span>{label} · {group.rows.length}{vi?" khoản":"건"}</span>{group.unpaidCount>0?<span className={styles.pendingBadge}>{vi?"Chưa thanh toán":"미결제"} {group.unpaidCount}</span>:null}</span><i aria-hidden>{open?"⌄":"›"}</i>
      </button>
      {open?<PayableDateGroups rows={group.rows} lang={lang}/>:null}
    </section>;
  })}</div>;
}

// Past-month detail is read on open, for this party and month only, with the same
// month-end as-of contract the month view used (paid/partial/unpaid as of month end).
function HistoricalPayablePartySheet({lang,month,party,onClose}:{lang:"ko"|"vi";month:string;party:PayableParty;onClose:()=>void}) {
  const vi=lang==="vi";
  const [rows,setRows]=useState<PayableHistoryRow[]|null>(null),[loadError,setLoadError]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    void (async()=>{
      try{
        const response=await fetch(`/api/admin/ledger/payables?month=${month}&historyPartyId=${party.partyId}`,{cache:"no-store",signal:controller.signal});
        const body=await response.json();
        if(controller.signal.aborted)return;
        if(!response.ok||body.month!==month||Number(body.partyId)!==party.partyId)throw new Error(body.code??"PAYABLE_HISTORY_LOAD_FAILED");
        setRows(body.historyPayables as PayableHistoryRow[]);
      }catch{if(!controller.signal.aborted)setLoadError(true)}
    })();
    return()=>controller.abort();
  },[month,party.partyId]);
  return <BarSheet kind="full" compact topAligned comfortableTop title={`${month} · ${vi?"Công nợ cuối tháng":"월말 미납 상세"}`} closeLabel={vi?"Đóng":"닫기"} saving={false} onClose={onClose} footer={<button type="button" onClick={onClose} style={{...secondaryButtonStyle,width:"100%"}}>{vi?"Đóng":"닫기"}</button>}>
    <div className={styles.payableDetailHeader}><div className={styles.payableDetailPartner}><span className={styles.partnerTypeBadge}>{partnerTypeLabel(party.partnerType,lang)}</span><strong>{party.partyName}</strong></div><span>{vi?"Tổng công nợ":"총 미납"} <b>{money(party.closingOutstanding)}</b></span></div>
    <p className={styles.payableReadOnlyHint} role="status">{vi?"Số dư cuối tháng đã chọn. Không thể thanh toán giao dịch cũ.":"선택월 말 기준 잔액입니다. 과거 내역은 결제할 수 없습니다."}</p>
    <PayableMonthTotals summary={party} vi={vi}/>
    {loadError?<p className={styles.error} role="alert">{vi?"Không thể tải chi tiết công nợ.":"미납 상세를 불러오지 못했습니다."}</p>
      :rows===null?<p className={styles.payableEmpty}>{vi?"Đang tải…":"불러오는 중…"}</p>
      :<><PayableMonthGroups rows={rows} lang={lang}/>{!rows.length?<p className={styles.payableEmpty}>{vi?"Không có công nợ cuối tháng.":"선택월 말 미납금이 없습니다."}</p>:null}</>}
  </BarSheet>;
}

function PayablePartySheet({ lang, party, accounts, onClose, onPaid }: {
  lang:"ko"|"vi"; party:PayableParty; accounts:Account[]; onClose:()=>void; onPaid:()=>Promise<void>;
}) {
  const vi=lang==="vi", initial=localTime();
  const [detail,setDetail]=useState<PayableDetail|null>(null),[selectedDates,setSelectedDates]=useState<Set<string>>(()=>new Set()),[accountId,setAccountId]=useState(""),[date,setDate]=useState(initial.slice(0,10)),[time,setTime]=useState(initial.slice(11,16)),[memo,setMemo]=useState(""),[saving,setSaving]=useState(false),[error,setError]=useState("");
  // Added after the existing hooks so hook order stays stable for the rendering harness in tests/ledger-deployed-qa.
  const [mode,setMode]=useState<"dates"|"partial"|"history">("dates"),[partialAmount,setPartialAmount]=useState("");
  const loadDetail=useCallback(async()=>{setError("");try{const response=await fetch(`/api/admin/ledger/payables/${party.partyId}`,{cache:"no-store"}),body=await response.json();if(!response.ok)throw new Error(body.code);setDetail(body)}catch{setError(vi?"Không thể tải chi tiết công nợ.":"미납 상세를 불러오지 못했습니다.")}},[party.partyId,vi]);
  useEffect(()=>{void loadDetail()},[loadDetail]);
  const groups=useMemo(()=>groupPayableRows(detail?.payables??[]),[detail]);
  const selectedGroups=groups.filter(group=>selectedDates.has(group.businessDate)),selectedTotal=selectedGroups.reduce((sum,group)=>sum+group.total,0),selectedPayables=selectedGroups.flatMap(group=>group.rows);
  // 부분 지급: amount is allocated oldest-first by buildOldestFirstAllocations(); the preview is exactly what is sent.
  const partialRows=useMemo(()=>(detail?.payables??[]).map(row=>({id:Number(row.id),businessDate:row.expense?.business_date??"",outstandingAmount:Number(row.outstandingAmount)})),[detail]);
  const partialPlan=useMemo(()=>planPartialPayablePayment(partialRows,parseLedgerAmount(partialAmount)??0),[partialRows,partialAmount]);
  const rowById=useMemo(()=>new Map((detail?.payables??[]).map(row=>[Number(row.id),row])),[detail]);
  // 지급 내역: date + daily total only (allocation/item/memo/account stay in the data, not shown).
  const dailyPayments=useMemo(()=>groupPaymentsByDate(detail?.payments??[]),[detail]);
  const canPay=mode==="dates"?!!selectedPayables.length:mode==="partial"&&partialPlan.error===null;
  async function payPartial(){if(saving||!accountId||partialPlan.error!==null)return;setSaving(true);setError("");try{const response=await fetch("/api/admin/ledger/payables/pay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({partyId:party.partyId,fundAccountId:Number(accountId),occurredAt:`${date}T${time}:00+07:00`,amount:partialPlan.amount,allocations:partialPlan.allocations,memo:memo||null})}),body=await response.json();if(!response.ok)throw new Error(body.code);setPartialAmount("");await onPaid()}catch(cause){setError(`${vi?"Không thể thanh toán.":"결제하지 못했습니다."} ${(cause as Error).message}`)}finally{setSaving(false)}}
  async function pay(){if(saving||!accountId||!selectedPayables.length)return;setSaving(true);setError("");try{const response=await fetch("/api/admin/ledger/payables/pay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({partyId:party.partyId,fundAccountId:Number(accountId),occurredAt:`${date}T${time}:00+07:00`,amount:selectedTotal,allocations:selectedPayables.map(row=>({payableId:row.id,allocatedAmount:row.outstandingAmount})),memo:memo||null})}),body=await response.json();if(!response.ok)throw new Error(body.code);setSelectedDates(new Set());await onPaid()}catch(cause){setError(`${vi?"Không thể thanh toán.":"결제하지 못했습니다."} ${(cause as Error).message}`)}finally{setSaving(false)}}
  return <BarSheet kind="full" compact topAligned comfortableTop fillAvailable containedBody title={vi?"Chi tiết công nợ":"미납금 상세"} closeLabel={vi?"Đóng":"닫기"} saving={saving} onClose={onClose} footer={<div className={styles.detailFooter}>{mode==="history"?null:<button type="button" disabled={saving||!accountId||!canPay} onClick={()=>void (mode==="dates"?pay():payPartial())} style={{...primaryButtonStyle,width:"100%"}}>{saving?(vi?"Đang thanh toán…":"결제 중…"):mode==="dates"?(vi?`Thanh toán ${selectedDates.size} ngày đã chọn`:`선택 일자 ${selectedDates.size}건 결제`):(vi?`Thanh toán một phần ${money(partialPlan.error===null?partialPlan.amount:0)}`:`부분 지급 ${money(partialPlan.error===null?partialPlan.amount:0)}`)}</button>}<button type="button" disabled={saving} onClick={onClose} style={{...secondaryButtonStyle,width:"100%"}}>{vi?"Đóng":"닫기"}</button></div>}>
    <div className={styles.payableSheetBody}>
    <div className={styles.payableDetailHeader}><strong>🤝 {party.partyName}</strong><span>{vi?"Tổng công nợ":"총 미납"} <b>{money(detail?.totalOutstanding??party.outstandingAmount)}</b></span></div>
    <p className={styles.payablePartyMeta}>{vi?"Đầu tiên":"최초"} {party.oldestDate||"-"} · {vi?"Hạn":"예정"} {party.nearestDueDate??(vi?"Chưa định":"미정")} · {vi?"Thanh toán gần nhất":"최근 지급"} {party.recentPaymentDate??(vi?"Không có":"없음")}</p>
    {error?<p className={styles.error} role="alert">{error}</p>:null}
    {detail?<div className={styles.payModeTabs} role="group" aria-label={vi?"Cách thanh toán":"지급 방식"}><button type="button" aria-pressed={mode==="dates"} disabled={saving} onClick={()=>setMode("dates")}>{vi?"Theo ngày":"선택 일자 결제"}</button><button type="button" aria-pressed={mode==="partial"} disabled={saving||!groups.length} onClick={()=>setMode("partial")}>{vi?"Thanh toán một phần":"부분 지급"}</button><button type="button" aria-pressed={mode==="history"} disabled={saving} onClick={()=>setMode("history")}>{vi?"Lịch sử":"지급 내역"} {detail.payments?.length??0}</button></div>:null}
    {mode==="history"
      ?<div className={styles.paymentHistory}>{dailyPayments.length?dailyPayments.map(day=><div key={day.businessDate} className={styles.paymentHistoryRow}><span>{formatDate(day.businessDate,lang)}</span><strong>{money(day.amount)}</strong></div>):<p className={styles.paymentHistoryEmpty}>{vi?"Chưa có lịch sử thanh toán.":"지급 내역이 없습니다."}</p>}</div>
    :mode==="dates"
      ?<PayableDateGroups rows={detail?.payables??[]} lang={lang} selectedDates={selectedDates} onSelectDate={date=>setSelectedDates(current=>{const next=new Set(current);if(next.has(date))next.delete(date);else next.add(date);return next})}/>
      :<div className={styles.partialPayment}>
        <BarField label={`💰 ${vi?"Số tiền thanh toán":"지급액"}`} required compact help={`${vi?"Tối đa":"최대"} ${money(partialPlan.totalOutstanding)}`}>{({id})=><input id={id} inputMode="numeric" value={formatLedgerAmountInput(partialAmount)} onChange={event=>setPartialAmount(sanitizeLedgerAmountInput(event.target.value))} style={keepingInputStyle}/>}</BarField>
        {partialPlan.error==="exceeds_outstanding"?<p className={styles.error} role="alert">{vi?"Vượt quá tổng công nợ.":"총 미납금을 초과할 수 없습니다."}</p>:null}
        {partialPlan.error===null?<div className={styles.allocationPreview}><strong>{vi?"Phân bổ dự kiến (cũ nhất trước)":"배분 예정 (오래된 외상부터)"}</strong>{partialPlan.allocations.map(allocation=>{const row=rowById.get(allocation.payableId);return <span key={allocation.payableId}><em>{row?.expense?.business_date?formatDate(row.expense.business_date,lang):"-"} · {row?payableItemLabel(row,vi):"-"}</em><b>{money(allocation.allocatedAmount)}</b></span>})}</div>:null}
      </div>}
    {mode!=="history"&&!groups.length&&!error?<p className={styles.payableEmpty}>{vi?"Không có công nợ chưa thanh toán.":"미납금이 없습니다."}</p>:null}
    {mode==="history"?null:<div className={styles.paymentForm}>{mode==="dates"?<div className={styles.selectedTotal}><span>{vi?"Công nợ đã chọn":"선택 미납금"}</span><strong>{money(selectedTotal)}</strong></div>:null}<div className={styles.manualSingle}><AccountField lang={lang} label={`🏦 ${vi?"Tài khoản chi":"출금 계정"}`} value={accountId} setValue={setAccountId} accounts={accounts}/></div><div className={styles.manualRow}><BarField label={`📅 ${vi?"Ngày thanh toán":"결제일"}`} required compact>{({id})=><input id={id} type="date" value={date} onChange={event=>setDate(event.target.value)} style={keepingInputStyle}/>}</BarField><BarField label={`🕒 ${vi?"Thời gian":"시간"}`} required compact>{({id})=><input id={id} type="time" value={time} onChange={event=>setTime(event.target.value)} style={keepingInputStyle}/>}</BarField></div><BarField label={`📝 ${vi?"Ghi chú":"메모"}`} compact>{({id})=><input id={id} value={memo} onChange={event=>setMemo(event.target.value)} style={keepingInputStyle}/>}</BarField></div>}
    </div>
  </BarSheet>
}

function payableItemLabel(row:PayableRow,vi:boolean){const snapshot=row.expense?.display_snapshot??row.expense?.source_snapshot;return String((vi?snapshot?.item_name_vi:null)??snapshot?.item_name??snapshot?.itemName??snapshot?.name??(vi?"Mặt hàng tồn kho":"재고 품목"))}

function ManualEntrySheet({
  lang,
  data,
  investments,
  month,
  saving,
  setSaving,
  onClose,
  onSaved,
  returnFocusRef,
}: {
  lang: "ko" | "vi";
  data: LedgerData;
  investments: InvestmentsData | null;
  month: string;
  saving: boolean;
  setSaving: (value: boolean) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const initial = localTime(),
    vi = lang === "vi";
  const [type, setType] = useState<EntryType>("expense"),
    [amount, setAmount] = useState(""),
    [occurredDate, setOccurredDate] = useState(initial.slice(0, 10)),
    [occurredTime, setOccurredTime] = useState(initial.slice(11, 16)),
    [categoryId, setCategoryId] = useState(""),
    [partnerId, setPartnerId] = useState(""),
    [fromAccountId, setFromAccountId] = useState(""),
    [toAccountId, setToAccountId] = useState(""),
    [adjustmentType, setAdjustmentType] = useState<"general" | "investment">("general"),
    [balanceDirection, setBalanceDirection] = useState<"increase" | "decrease">("increase"),
    [investmentAction, setInvestmentAction] = useState<"contribution" | "recovery">("contribution"),
    [participantId, setParticipantId] = useState(""),
    [memo, setMemo] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [employeeId, setEmployeeId] = useState(""),
    [employees, setEmployees] = useState<PayrollAdvanceEmployee[] | null>(null),
    [employeesError, setEmployeesError] = useState(""),
    // One idempotency key per advance being entered; a retry after a network
    // error reuses it, and a new key is issued only after a successful save.
    [advanceRequestId, setAdvanceRequestId] = useState(() => crypto.randomUUID());
  const categories =
      type === "expense"
        ? data.categories
            .filter(isManualExpenseCategory)
            .sort(manualExpenseCategorySort)
        : type === "income"
          ? data.categories
              .filter(isManualIncomeCategory)
              .sort(manualIncomeCategorySort)
          : [],
    accounts = data.accounts.filter((row) => row.is_active),
    investmentAccounts = accounts.filter((row) => row.is_business_fund && ["cash", "bank", "personal_custody"].includes(row.type)),
    selectedPartner = data.partners.find((row) => String(row.id) === partnerId),
    employeeGroups = groupPayrollAdvanceEmployees(employees ?? []),
    partText = adminUsersText[lang];
  // 👥 가불 looks like an expense category but is saved as a payroll advance
  // (payroll_payment + payroll adjustment), never as a P&L expense.
  const payrollAdvance = type === "expense" && isPayrollAdvanceManualAction(categoryId);
  function changeType(next: EntryType) {
    setType(next);
    setCategoryId("");
  }
  async function changeExpenseCategory(next: string) {
    setCategoryId(next);
    if (!isPayrollAdvanceManualAction(next)) return;
    setPartnerId("");
    if (employees) return;
    setEmployeesError("");
    try {
      const response = await fetch("/api/admin/ledger/payroll-advances", { cache: "no-store" }),
        body = await response.json();
      if (!response.ok) throw new Error(body.code);
      setEmployees(body.employees ?? []);
    } catch (cause) {
      setEmployeesError(`${vi ? "Không thể tải danh sách nhân viên." : "직원 목록을 불러오지 못했습니다."} ${(cause as Error).message}`);
    }
  }
  function changeEmployee(next: string) {
    const previous = employees?.find((row) => String(row.userId) === employeeId),
      selected = employees?.find((row) => String(row.userId) === next);
    setEmployeeId(next);
    // Suggest "<name> 급여 가불" but keep anything the user typed.
    if (!memo.trim() || (previous && memo === payrollAdvanceDefaultMemo(previous.name)))
      setMemo(selected ? payrollAdvanceDefaultMemo(selected.name) : "");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const amountValue = parseLedgerAmount(amount);
      if (amountValue === null)
        throw new Error(
          vi
            ? "Số tiền phải là số nguyên dương hợp lệ."
            : "금액은 안전한 범위의 양의 정수여야 합니다.",
        );
      if (type === "balance_adjustment" && adjustmentType === "investment" && !investments?.configured) {
        throw new Error(vi ? "Tình hình vốn góp của tháng này chưa được thiết lập." : "선택월 투자금 현황이 설정되지 않았습니다.");
      }
      const isInvestmentAdjustment = type === "balance_adjustment" && adjustmentType === "investment";
      if (payrollAdvance && !employeeId) throw new Error(vi ? "Hãy chọn nhân viên." : "직원을 선택하세요.");
      if (payrollAdvance && !fromAccountId) throw new Error(vi ? "Hãy chọn tài khoản chi." : "출금 계정을 선택하세요.");
      const response = await fetch(payrollAdvance ? "/api/admin/ledger/payroll-advances" : isInvestmentAdjustment ? "/api/admin/ledger/investments" : "/api/admin/ledger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payrollAdvance ? {
            requestId: advanceRequestId,
            userId: Number(employeeId),
            amount: amountValue,
            occurredAt: `${occurredDate}T${occurredTime}:00+07:00`,
            fromAccountId: Number(fromAccountId),
            memo: memo || null,
          } : isInvestmentAdjustment ? {
            participantId: Number(participantId),
            action: investmentAction,
            amount: amountValue,
            occurredAt: `${occurredDate}T${occurredTime}:00+07:00`,
            fundAccountId: Number(investmentAction === "contribution" ? toAccountId : fromAccountId),
            reason,
            memo,
          } : {
            type,
            amount: amountValue,
            occurredAt: `${occurredDate}T${occurredTime}:00+07:00`,
            recognitionMonth:
              type === "income" || type === "expense" ? `${month}-01` : null,
            categoryId:
              type === "income" || type === "expense"
                ? Number(selectedPartner?.manualExpenseCategoryId ?? categoryId)
                : null,
            partyId: type === "expense" ? (selectedPartner?.ledgerPartyId ?? null) : null,
            businessPartnerId: type === "expense" ? (selectedPartner?.id ?? null) : null,
            fromAccountId:
              type === "expense" ||
              type === "transfer" ||
              (type === "balance_adjustment" && balanceDirection === "decrease")
                ? Number(fromAccountId)
                : null,
            toAccountId:
              type === "income" ||
              type === "transfer" ||
              (type === "balance_adjustment" && balanceDirection === "increase")
                ? Number(toAccountId)
                : null,
            memo,
            reason,
          }),
        }),
        body = await response.json();
      if (!response.ok) throw new Error(body.code);
      if (payrollAdvance) setAdvanceRequestId(crypto.randomUUID());
      await onSaved();
    } catch (cause) {
      setError(
        `${vi ? "Không thể lưu." : "저장하지 못했습니다."} ${(cause as Error).message}`,
      );
    } finally {
      setSaving(false);
    }
  }
  const outgoing =
      type === "expense" ||
      type === "transfer" ||
      (type === "balance_adjustment" && balanceDirection === "decrease"),
    incoming =
      type === "income" ||
      type === "transfer" ||
      (type === "balance_adjustment" && balanceDirection === "increase");
  return (
    <BarSheet
      kind="bottom"
      topAligned
      comfortableTop
      title={vi ? "Thêm giao dịch" : "장부 내역 추가"}
      closeLabel={vi ? "Đóng" : "닫기"}
      saving={saving}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <button
          form="manual-ledger-entry"
          disabled={saving}
          style={{ ...primaryButtonStyle, width: "100%" }}
        >
          {saving
            ? vi
              ? "Đang lưu..."
              : "저장 중…"
            : vi
              ? "Lưu vào sổ"
              : "장부에 저장"}
        </button>
      }
    >
      <form
        id="manual-ledger-entry"
        className={styles.manualForm}
        onSubmit={submit}
      >
        <BarSegmentedControl
          scrollable
          label={vi ? "Loại giao dịch" : "거래 유형"}
          value={type}
          disabled={saving}
          onChange={changeType}
          options={[
            { value: "expense", label: `💸 ${vi ? "Chi" : "지출"}` },
            { value: "income", label: `💰 ${vi ? "Thu" : "수입"}` },
            { value: "transfer", label: `🔄 ${vi ? "Chuyển tiền" : "이체"}` },
            {
              value: "balance_adjustment",
              label: `⚖️ ${vi ? "Điều chỉnh số dư" : "잔액조정"}`,
            },
          ]}
        />
        <div className={styles.manualGrid}>
          <div className={`${styles.manualRow} ${type === "transfer" ? styles.manualSingle : ""}`}>
            <BarField label={`💵 ${vi ? "Số tiền" : "금액"}`} required compact>
              {({ id }) => (
                <input
                  id={id}
                  data-manual-field="amount"
                  required
                  inputMode="numeric"
                  autoComplete="off"
                  value={formatLedgerAmountInput(amount)}
                  onChange={(event) =>
                    setAmount(sanitizeLedgerAmountInput(event.target.value))
                  }
                  style={keepingInputStyle}
                />
              )}
            </BarField>
            {payrollAdvance ? (
              <BarField label={`👤 ${vi ? "Nhân viên" : "직원"}`} required compact>
                {({ id }) => (
                  <select id={id} data-manual-field="employee" required value={employeeId} onChange={(event) => changeEmployee(event.target.value)} style={keepingInputStyle}>
                    <option value="">{employees ? (vi ? "Chọn" : "선택") : (vi ? "Đang tải…" : "불러오는 중…")}</option>
                    {employeeGroups.map((group) => (
                      <optgroup key={group.part} label={group.part === "owner" ? (vi ? partText.ownerGroup : "Owner") : partText[`${group.part}Group`]}>
                        {group.employees.map((employee) => (
                          <option key={employee.userId} value={employee.userId}>{employee.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </BarField>
            ) : type === "expense" ? (
              <BarField label={`🤝 ${vi ? "Đối tác (không bắt buộc)" : "거래처 (선택)"}`} compact>
                {({ id }) => (
                  <PartnerSelect id={id} manual partners={data.partners} lang={lang} value={partnerId} onChange={setPartnerId} />
                )}
              </BarField>
            ) : type === "income" ? (
              <BarField
                label={`🏷️ ${vi ? "Danh mục" : "카테고리"}`}
                required
                compact
              >
                {({ id }) => (
                  <select
                    id={id}
                    data-manual-field="income-category"
                    required
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                    style={keepingInputStyle}
                  >
                    <option value="">{vi ? "Chọn" : "선택"}</option>
                    {categories.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                  </select>
                )}
              </BarField>
            ) : type === "balance_adjustment" ? (
              <BarField label={`⚖️ ${vi ? "Loại điều chỉnh" : "조정유형"}`} required compact>
                {({ id }) => (
                  <select
                    id={id}
                    data-manual-field="adjustment-type"
                    required
                    value={adjustmentType}
                    onChange={(event) => {
                      setAdjustmentType(event.target.value as "general" | "investment");
                      setFromAccountId("");
                      setToAccountId("");
                    }}
                    style={keepingInputStyle}
                  >
                    <option value="general">{vi ? "Điều chỉnh số dư thông thường" : "일반 잔액조정"}</option>
                    <option value="investment" disabled={!investments?.configured}>{vi ? "Điều chỉnh vốn góp" : "투자금 조정"}</option>
                  </select>
                )}
              </BarField>
            ) : null}
          </div>
          {type === "expense" ? (
            <div className={styles.manualRow}>
              <BarField label={`🏷️ ${vi ? "Danh mục" : "카테고리"}`} required compact>
                {({ id }) => selectedPartner ? (
                  <input
                    id={id}
                    data-manual-field="expense-category"
                    readOnly
                    aria-readonly="true"
                    value={selectedPartner.manualExpenseCategoryName
                      ? manualExpenseCategoryLabel(selectedPartner.manualExpenseCategoryName, lang)
                      : (vi ? "Chưa liên kết danh mục" : "카테고리 연결 필요")}
                    className={styles.manualReadOnly}
                    style={keepingInputStyle}
                  />
                ) : (
                  <select id={id} data-manual-field="expense-category" required value={categoryId} onChange={(event) => void changeExpenseCategory(event.target.value)} style={keepingInputStyle}>
                    <option value="">{vi ? "Chọn" : "선택"}</option>
                    {categories.map((row) => <option key={row.id} value={row.id}>{manualExpenseCategoryLabel(row.name, lang)}</option>)}
                    {MANUAL_EXPENSE_SPECIAL_ACTIONS.map((action) => <option key={action.value} value={action.value}>{manualExpenseSpecialActionLabel(action, lang)}</option>)}
                  </select>
                )}
              </BarField>
              <AccountField
                lang={lang}
                label={`🏦 ${vi ? "Tài khoản chi" : "출금 계정"}`}
                fieldName="expense-account"
                value={fromAccountId}
                setValue={setFromAccountId}
                accounts={accounts}
              />
            </div>
          ) : type === "income" ? (
            <div className={`${styles.manualRow} ${styles.manualSingle}`}>
              <AccountField
                lang={lang}
                label={`🏦 ${vi ? "Tài khoản nhận" : "입금 계정"}`}
                fieldName="income-account"
                value={toAccountId}
                setValue={setToAccountId}
                accounts={accounts}
              />
            </div>
          ) : type === "transfer" ? (
            <div className={styles.manualRow}>
              <AccountField lang={lang} label={`🏦 ${vi ? "Tài khoản chi" : "출금 계정"}`} fieldName="transfer-from-account" value={fromAccountId} setValue={setFromAccountId} accounts={accounts}/>
              <AccountField lang={lang} label={`🏦 ${vi ? "Tài khoản nhận" : "입금 계정"}`} fieldName="transfer-to-account" value={toAccountId} setValue={setToAccountId} accounts={accounts}/>
            </div>
          ) : adjustmentType === "general" ? (
            <div className={styles.manualRow}>
              <BarField label={`↕️ ${vi ? "Tăng / giảm" : "증가/감소"}`} required compact>
                {({ id }) => (
                  <select
                    id={id}
                    data-manual-field="balance-direction"
                    required
                    value={balanceDirection}
                    onChange={(event) => {
                      setBalanceDirection(event.target.value as "increase" | "decrease");
                      setFromAccountId("");
                      setToAccountId("");
                    }}
                    style={keepingInputStyle}
                  >
                    <option value="increase">{vi ? "Tăng" : "증가"}</option>
                    <option value="decrease">{vi ? "Giảm" : "감소"}</option>
                  </select>
                )}
              </BarField>
              {outgoing ? <AccountField lang={lang} label={`🏦 ${vi ? "Tài khoản điều chỉnh" : "조정 계정"}`} fieldName="balance-account" value={fromAccountId} setValue={setFromAccountId} accounts={accounts}/> : null}
              {incoming ? <AccountField lang={lang} label={`🏦 ${vi ? "Tài khoản điều chỉnh" : "조정 계정"}`} fieldName="balance-account" value={toAccountId} setValue={setToAccountId} accounts={accounts}/> : null}
            </div>
          ) : (
            <>
              <div className={styles.manualRow}>
                <BarField label={`👤 ${vi ? "Nhà đầu tư" : "투자자"}`} required compact>
                  {({ id }) => (
                    <select id={id} data-manual-field="participant" required value={participantId} onChange={(event) => setParticipantId(event.target.value)} style={keepingInputStyle}>
                      <option value="">{vi ? "Chọn" : "선택"}</option>
                      {(investments?.participants ?? []).map((participant) => (
                        <option key={participant.participantId} value={participant.participantId}>{participant.participantName}</option>
                      ))}
                    </select>
                  )}
                </BarField>
                <BarField label={`↕️ ${vi ? "Giao dịch vốn" : "추가투자 / 투자금 회수"}`} required compact>
                  {({ id }) => (
                    <select
                      id={id}
                      data-manual-field="investment-action"
                      required
                      value={investmentAction}
                      onChange={(event) => {
                        setInvestmentAction(event.target.value as "contribution" | "recovery");
                        setFromAccountId("");
                        setToAccountId("");
                      }}
                      style={keepingInputStyle}
                    >
                      <option value="contribution">{vi ? "Góp thêm vốn" : "추가투자"}</option>
                      <option value="recovery">{vi ? "Thu hồi vốn" : "투자금 회수"}</option>
                    </select>
                  )}
                </BarField>
              </div>
              <div className={`${styles.manualRow} ${styles.manualSingle}`}>
                <AccountField
                  lang={lang}
                  label={`🏦 ${vi ? "Tài khoản vốn" : "자금 계정"}`}
                  fieldName="investment-account"
                  value={investmentAction === "contribution" ? toAccountId : fromAccountId}
                  setValue={investmentAction === "contribution" ? setToAccountId : setFromAccountId}
                  accounts={investmentAccounts}
                />
              </div>
            </>
          )}
          {payrollAdvance ? (
            <p className={styles.manualNotice}>{vi
              ? "Ứng lương được trừ vào lương tháng này và không được tính thêm là chi phí nhân công."
              : "가불은 이번 달 급여에서 차감되며 인건비로 추가 인식되지 않습니다."}</p>
          ) : null}
          {employeesError ? <p className={styles.error} role="alert">{employeesError}</p> : null}
          {type === "balance_adjustment" && adjustmentType === "investment" && !investments?.configured ? (
            <p className={styles.manualNotice}>{vi ? "Tháng đã chọn chưa được thiết lập nhà đầu tư." : "선택월 투자금 현황이 설정되지 않아 투자금 조정을 저장할 수 없습니다."}</p>
          ) : null}
          <div className={styles.manualRow}>
            <BarField label={`📅 ${vi ? "Ngày phát sinh" : "발생일"}`} required compact>
              {({ id }) => <input id={id} data-manual-field="date" required type="date" value={occurredDate} onChange={(event) => setOccurredDate(event.target.value)} style={keepingInputStyle}/>} 
            </BarField>
            <BarField label={`🕒 ${vi ? "Thời gian" : "시간"}`} required compact>
              {({ id }) => <input id={id} data-manual-field="time" required type="time" value={occurredTime} onChange={(event) => setOccurredTime(event.target.value)} style={keepingInputStyle}/>} 
            </BarField>
          </div>
          {type === "balance_adjustment" ? (
            <div className={styles.manualFull}>
              <BarField
                label={`⚖️ ${vi ? "Lý do điều chỉnh" : "조정 사유"}`}
                required
                compact
              >
                {({ id }) => (
                  <input
                    id={id}
                    data-manual-field="reason"
                    required
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    style={keepingInputStyle}
                  />
                )}
              </BarField>
            </div>
          ) : null}
          <div className={styles.manualFull}>
            <BarField label={`📝 ${vi ? "Ghi chú" : "메모"}`} compact>
              {({ id }) => (
                <input
                  id={id}
                  data-manual-field="memo"
                  value={memo}
                  onChange={(event) => setMemo(event.target.value)}
                  style={keepingInputStyle}
                />
              )}
            </BarField>
          </div>
        </div>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </BarSheet>
  );
}
function AccountField({
  lang,
  label,
  fieldName,
  value,
  setValue,
  accounts,
}: {
  lang: "ko" | "vi";
  label: string;
  fieldName?: string;
  value: string;
  setValue: (value: string) => void;
  accounts: Account[];
}) {
  return (
    <BarField label={label} required compact>
      {({ id }) => (
        <select
          id={id}
          data-manual-field={fieldName}
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
          style={keepingInputStyle}
        >
          <option value="">{lang === "vi" ? "Chọn" : "선택"}</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.display_name}
            </option>
          ))}
        </select>
      )}
    </BarField>
  );
}
function entryDisplayEmoji(entry: LedgerEntry, partnersByParty: ReadonlyMap<number, Partner>) {
  if (entry.userAdjustment) return entryCategoryEmoji(entry);
  if (entry.systemDisplay?.kind === "reserve") return entryCategoryEmoji(entry);
  if (entry.systemDisplay?.kind === "investment") return entryCategoryEmoji(entry);
  if (entry.systemDisplay?.kind === "pos") return entryCategoryEmoji(entry);
  if (entry.systemDisplay?.kind === "cardSettlementDeposit" || entry.systemDisplay?.kind === "cardSettlementDifference" || entry.systemDisplay?.kind === "cardFeeMonthClose") return entryCategoryEmoji(entry);
  if (entry.employeeCost) return EMPLOYEE_COST_EMOJI;
  if (entry.partyId != null) {
    const partner = partnersByParty.get(entry.partyId);
    if (partner) return chooseLedgerEntryEmoji(partner.emoji, entryCategoryEmoji(entry));
  }
  return entryCategoryEmoji(entry);
}

function entryMeta(entry: LedgerEntry, lang: "ko" | "vi" = "ko") {
  const settlement = entry.settlementStatus === "partial"
    ? `${lang === "vi" ? "Còn nợ" : "일부 미지급"} ${money(entry.remainingAmount ?? 0)}` : "";
  if (entry.systemDisplay?.kind === "pos") {
    return lang === "vi"
      ? `${entry.systemDisplay.receiptCount.toLocaleString("vi-VN")} hóa đơn`
      : `영수증 ${entry.systemDisplay.receiptCount.toLocaleString("ko-KR")}건`;
  }
  if (entry.systemDisplay?.kind === "meal") return "";
  if (entry.systemDisplay?.kind === "reserve") return reserveEntryTypeLabel(entry.systemDisplay.entryType, lang);
  if (entry.systemDisplay?.kind === "inventory") {
    const items = lang === "vi"
      ? `${entry.systemDisplay.itemCount.toLocaleString("vi-VN")} mặt hàng`
      : `${entry.systemDisplay.itemCount.toLocaleString("ko-KR")}품목`;
    return [items, settlement].filter(Boolean).join(" · ");
  }
  if (entry.systemDisplay?.kind === "rent") return lang === "vi" ? "Tiền thuê" : "임대료";
  const vi = lang === "vi",
    subtitle = entry.subtitle.replace(/\s*·\s*확인 필요/g, "");
  return [
    subtitle === entry.categoryName || subtitle === "수동 입력" && entry.origin === "manual" ? "" : subtitle,
    settlement,
    entry.origin === "manual" ? (vi ? "Thủ công" : "수동") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
function compactEntryListTitle(title: string) {
  const firstLine = title.split(/\r?\n/, 1)[0].trim();
  return firstLine.length > 72 ? `${firstLine.slice(0, 72).trimEnd()}…` : firstLine;
}

function entryDisplayTitle(entry: LedgerEntry, lang: "ko" | "vi") {
  const display = entry.systemDisplay;
  if (display?.kind === "pos") {
    const labels = lang === "vi"
      ? { cash: "POS tiền mặt", transfer: "POS chuyển khoản", card: "POS thẻ", other: "POS khác" }
      : { cash: "POS 현금매출", transfer: "POS 계좌이체 매출", card: "POS 카드매출", other: "POS 기타매출" };
    return labels[display.paymentBucket];
  }
  if (display?.kind === "meal") {
    if (display.employeeCount <= 0) return lang === "vi" ? "Suất ăn nhân viên" : "직원 식대";
    return lang === "vi"
      ? `Suất ăn nhân viên · ${display.employeeCount.toLocaleString("vi-VN")} người`
      : `직원 식대 · ${display.employeeCount.toLocaleString("ko-KR")}명`;
  }
  if (display?.kind === "inventory" && display.partyMissing && !entry.title.trim()) {
    return lang === "vi" ? "Chưa chỉ định nhà cung cấp" : "거래처 미지정";
  }
  if (display?.kind === "rent") return lang === "vi" ? "Tiền thuê mặt bằng" : "매장 임대료";
  if (display?.kind === "payablePayment") {
    if (entry.title.trim()) return entry.title;
    const fallback = lang === "vi" ? "Công nợ" : "미지급금";
    const party = display.partyName || fallback;
    if (display.prepaid) return lang === "vi" ? `${party} trả trước` : `${party} 선지급`;
    return lang === "vi" ? `Thanh toán ${party}` : `${party} 지급`;
  }
  if (display?.kind === "cardSettlementDeposit") return lang === "vi" ? "Tiền thẻ thực nhận" : "카드 실제 입금";
  if (display?.kind === "cardSettlementDifference") return lang === "vi" ? "Chênh lệch đối soát thẻ cũ" : "기존 카드 정산차액";
  if (display?.kind === "cardFeeMonthClose") return lang === "vi" ? "Phí thẻ" : "카드 수수료";
  // The reserve's own name; never inferred from a linked recurring plan.
  if (display?.kind === "reserve") return display.reserveName;
  if (entry.paymentDifference) {
    const party = entry.paymentDifference.partyName || (lang === "vi" ? "Công nợ" : "미지급금");
    return lang === "vi" ? `Chênh lệch thanh toán ${party}` : `${party} 지급차액`;
  }
  return entry.title;
}
function reserveLabel(
  reserve: Account["reserves"][number],
  lang: "ko" | "vi",
) {
  if (reserve.linkedRecurringSourceKeyPrefix === "rent") {
    return lang === "vi" ? "Quỹ dự phòng tiền thuê" : "임대료 준비금";
  }
  return reserve.name;
}
function partnerTypeLabel(partnerType: string | null, lang: "ko" | "vi") {
  const labels = lang === "vi"
    ? { alcohol: "Rượu", food: "Thực phẩm", beverage: "Đồ uống", other: "Khác" }
    : { alcohol: "주류", food: "식자재", beverage: "음료", other: "기타" };
  return labels[partnerType as keyof typeof labels] ?? labels.other;
}
function isPayableAccount(accountName: string | null) {
  return accountName === "미지급";
}
function accountBadgeLabel(accountName: string | null, lang: "ko" | "vi", entry?: LedgerEntry) {
  if (entry?.systemDisplay?.kind === "cardSettlementDeposit") return lang === "vi" ? "Đối soát thẻ" : "카드정산";
  if (entry?.systemDisplay?.kind === "accountTransfer") return accountTransferBadgeLabel(entry.systemDisplay, lang);
  if (entry?.systemDisplay?.kind === "pos" && entry.systemDisplay.paymentBucket === "card") {
    return lang === "vi" ? "Thẻ" : "카드";
  }
  if (!accountName) return lang === "vi" ? "Chưa rõ" : "미지정";
  return shortLedgerAccountName(accountName, lang);
}
function investmentEntryTypeLabel(entryType: InvestmentEntryType, amount: number, lang: "ko" | "vi") {
  if (entryType === "opening") return lang === "vi" ? "Vốn góp ban đầu" : "기초 등록";
  if (entryType === "contribution") return lang === "vi" ? "Góp vốn thêm" : "추가투자";
  if (amount < 0) return lang === "vi" ? "Thu hồi vốn góp" : "투자금 회수";
  return lang === "vi" ? "Điều chỉnh vốn góp" : "투자금 조정";
}
// Compact status indicators for the daily list only.
function EntryListFlags({ entry, lang }: { entry: LedgerEntry; lang: "ko" | "vi" }) {
  const vi = lang === "vi";
  const statusLabel = [
    entry.status === "pending" ? (vi ? "C\u1ea7n x\u00e1c nh\u1eadn" : "\ud655\uc778 \ud544\uc694") : "",
    entry.requiresCorrection ? (vi ? "C\u1ea7n \u0111i\u1ec1u ch\u1ec9nh" : "\uc815\uc815 \ud544\uc694") : "",
  ].filter(Boolean).join(" \u00b7 ");
  const advanceCancelled = entry.ledgerPayrollAdvance?.cancelled ?? false;
  if (!statusLabel && !advanceCancelled) return null;
  return (
    <span className={styles.entryFlags}>
      {statusLabel ? <span className={styles.entryAlert} role="img" title={statusLabel} aria-label={statusLabel}>{"\u2757"}</span> : null}
      {advanceCancelled ? <span className={styles.cancelledBadge}>{vi ? "\u0110\u00e3 h\u1ee7y \u1ee9ng l\u01b0\u01a1ng" : "\uac00\ubd88 \ucde8\uc18c\ub428"}</span> : null}
    </span>
  );
}

// Text status flags for the detail summary.
function EntryFlags({ entry, lang }: { entry: LedgerEntry; lang: "ko" | "vi" }) {
  const vi = lang === "vi";
  const advanceCancelled = entry.ledgerPayrollAdvance?.cancelled ?? false;
  if (entry.status !== "pending" && !entry.requiresCorrection && !advanceCancelled) return null;
  return (
    <span className={styles.entryFlags}>
      {entry.status === "pending" ? <span className={styles.pendingBadge}>{vi ? "Cần xác nhận" : "확인 필요"}</span> : null}
      {entry.requiresCorrection ? <span className={styles.correctionBadge}>{vi ? "Cần điều chỉnh" : "정정 필요"}</span> : null}
      {advanceCancelled ? <span className={styles.cancelledBadge}>{vi ? "Đã hủy ứng lương" : "가불 취소됨"}</span> : null}
    </span>
  );
}

// Shared by the daily list and the detail summary. Display only; the
// accounting direction is untouched.
function EntryDisplayBadge({ entry, lang }: { entry: LedgerEntry; lang: "ko" | "vi" }) {
  const kind = entryDisplayBadgeKind(entry);
  return (
    <span className={`${styles.direction} ${styles[kind]}`} data-icon={entryDisplayBadgeEmoji(kind)}>
      {entryDisplayBadgeLabel(kind, lang)}
    </span>
  );
}
function formatDate(date: string, lang: "ko" | "vi" = "ko") {
  const [, month, day] = date.split("-").map(Number);
  return lang === "vi" ? `${day}/${month}` : `${month}월 ${day}일`;
}
function formatDateRange(startDate: string, endDate: string, lang: "ko" | "vi" = "ko") {
  const [, startMonth, startDay] = startDate.split("-").map(Number),
    [, endMonth, endDay] = endDate.split("-").map(Number);
  if (lang === "vi")
    return startMonth === endMonth
      ? `${startDay} ~ ${endDay}/${endMonth}`
      : `${startDay}/${startMonth} ~ ${endDay}/${endMonth}`;
  return startMonth === endMonth
    ? `${startMonth}월 ${startDay}일 ~ ${endDay}일`
    : `${startMonth}월 ${startDay}일 ~ ${endMonth}월 ${endDay}일`;
}
function localizedAccountName(account: Account, lang: "ko" | "vi") {
  if (lang === "ko")
    return accountShortName[account.code] ?? account.display_name;
  return (
    (
      {
        store_cash: "Tiền mặt",
        baba_corporate_bank: "Công ty",
        vuong_personal_custody: "Cá nhân Vương",
        cho_personal_custody: "Cá nhân Cho",
      } as Record<string, string>
    )[account.code] ?? account.display_name
  );
}

// Read-only: reserve history is informational and has no ledger transaction
// to edit, cancel or correct.
function ReserveEntryDetailSheet({ lang, entry, onClose }: { lang: "ko" | "vi"; entry: LedgerEntry; onClose: () => void }) {
  const vi = lang === "vi";
  if (entry.systemDisplay?.kind !== "reserve") return null;
  const reserve = entry.systemDisplay;
  return (
    <BarSheet
      kind="full"
      compact
      topAligned
      comfortableTop
      title={vi ? "Chi tiết quỹ dự phòng" : "준비금 상세"}
      titleAside={formatDate(entry.businessDate, lang)}
      closeLabel={vi ? "Đóng" : "닫기"}
      onClose={onClose}
      footer={
        <div className={styles.detailFooter}>
          <button type="button" onClick={onClose} style={{ ...secondaryButtonStyle, width: "100%" }}>
            {vi ? "Đóng" : "닫기"}
          </button>
        </div>
      }
    >
      <div className={styles.detailSummary}>
        <span className={styles.detailLeft}>
          <EntryDisplayBadge entry={entry} lang={lang} />
          <span className={styles.detailEmoji} aria-hidden="true">{entryCategoryEmoji(entry)}</span>
          <span className={styles.detailTitleText} title={reserve.reserveName}>
            <span className={styles.detailTitleLine}>
              <strong>{compactEntryListTitle(reserve.reserveName)}</strong>
            </span>
            <span> · {reserveEntryTypeLabel(reserve.entryType, lang)}</span>
          </span>
        </span>
        <span className={styles.detailPayment}>
          <span className={styles.accountBadge} title={entry.accountName ?? (vi ? "Không có tài khoản" : "계정 없음")}>
            {accountBadgeLabel(entry.accountName, lang, entry)}
          </span>
          <strong className={styles.detailAmount}>{money(entry.amount)}</strong>
        </span>
      </div>
      <p className={styles.policyNote}>
        {vi
          ? "Chỉ là thông tin quỹ dự phòng. Không phải thu/chi/chuyển khoản và không ảnh hưởng tổng thu chi theo ngày, lãi lỗ hay số dư tài khoản thực tế."
          : "준비금 기록은 정보성 장부 행입니다. 수입·지출·이체가 아니며 일별 합계, 손익, 실제 계좌잔액에 영향을 주지 않습니다."}
      </p>
      <dl className={styles.cardLegacyFacts}>
        <div><dt>{vi ? "Thời điểm" : "발생 시각"}</dt><dd>{formatDate(entry.businessDate, lang)} {entry.displayTime ?? ""}</dd></div>
        <div><dt>{vi ? "Loại" : "구분"}</dt><dd>{reserveEntryTypeLabel(reserve.entryType, lang)}</dd></div>
        <div><dt>{vi ? "Tài khoản" : "계좌"}</dt><dd>{entry.accountName ?? (vi ? "Chưa rõ" : "미지정")}</dd></div>
      </dl>
      {entry.memo?.trim() ? (
        <details className={styles.detailMemo}>
          <summary className={styles.detailMemoLabel}>{vi ? "Ghi chú" : "메모"}</summary>
          <p className={styles.detailMemoText}>{entry.memo}</p>
        </details>
      ) : null}
    </BarSheet>
  );
}
