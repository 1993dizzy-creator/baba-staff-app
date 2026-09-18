"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import Container from "@/components/Container";
import Link from "next/link";
import type { PayablePeriodSummary } from "@/lib/ledger/payables";
import { formatCardSettlementRate } from "@/lib/ledger/card-settlements";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import {
  BarField,
  BarSegmentedControl,
  BarSheet,
  keepingInputStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
} from "@/components/bar/keeping/KeepingUi";
import { entryDisplaySubtotal, type LedgerEntry, type LedgerEntryItem } from "@/lib/ledger/entries";
import {
  formatLedgerAmountInput,
  parseLedgerAmount,
  sanitizeLedgerAmountInput,
} from "@/lib/ledger/manual-entry-amount";
import {
  isManualExpenseCategory,
  manualExpenseCategoryLabel,
  manualExpenseCategorySort,
} from "@/lib/ledger/manual-entry-policy";
import styles from "./entries.module.css";
import { getBusinessDate } from "@/lib/common/business-time";

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
  paymentMode: "immediate" | "postpaid";
  defaultFundAccountId: number | null;
  isActive: boolean;
};
type LedgerSummary = {
  income: number;
  receivedIncome: number;
  expense: number;
  operatingProfit: number;
  paidExpense: number;
  displayedExpense: number;
  cardGrossSales: number;
  monthlySettledGross: number;
  actualCardDeposits: number;
  unsettledCardGross: number;
};
type LedgerData = {
  inventoryProjectionIssues?: Array<{ inventoryLogId: number; status: string; code: string }>;
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
type EntryFilter = "all" | "income" | "expense" | "manual" | "pending";
type EntryType = "expense" | "income" | "transfer" | "balance_adjustment";
type CandidateDraft = {
  item: LedgerEntryItem;
  resolution: "immediate" | "payable";
  categoryId: string;
  fundAccountId: string;
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
};
type PayableParty = PayablePeriodSummary & { partyId:number; partyName:string; partnerType:string|null; outstandingAmount:number; partialPaidAmount:number; totalOpenAmount:number; openCount:number };
type PayablesSummary = { month:string; summary:PayablePeriodSummary; totalOutstanding:number; parties:PayableParty[]; payables:PayableRow[] };
type PayableRow = { id:number; party_id:number; original_amount:number; outstandingAmount:number; expense:{business_date:string;source_snapshot?:Record<string,unknown>|null;display_snapshot?:Record<string,unknown>|null}|null };
type PayableDetail = { party:{id:number;name:string}; payables:PayableRow[]; totalOutstanding:number };
type CardSettlementSummary = { monthlyCardGross:number; monthlySettledGross:number; monthlyUnreconciledGross:number; monthlySettlementDifference:number; totalUnreconciledGross:number; cardPendingBalance:number };
type InvestmentEntryType = "opening" | "contribution" | "adjustment";
type InvestmentEvent = { investmentId:number; participantId:number; participantName:string; entryType:InvestmentEntryType; amount:number; businessDate:string; occurredAt:string; fundAccountId:number|null; fundAccountName:string|null; reason:string|null };
type InvestmentSummary = { openingCumulative:number; periodOpening:number; periodContribution:number; periodAdjustment:number; periodNetChange:number; closingCumulative:number };
type InvestmentsData = { month:string; configured:boolean; summary:InvestmentSummary; events:InvestmentEvent[] };
type MonthCloseState = { month: string; state: "open" | "closed" | "reopened"; revision: number | null };
const accountEmoji = (code:string,type:string) => code === "card_clearing" || type === "card_clearing" ? "💳" : code === "store_cash" ? "💵" : type === "personal_custody" || code.endsWith("_personal_custody") ? "👤" : "🏦";

const currentMonth = () => getBusinessDate().slice(0, 7);
const localTime = () =>
  new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 16);
const money = (amount: number) =>
  `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(amount))} ₫`;
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
const todayDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

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

export default function LedgerEntriesPage() {
  const { lang } = useLanguage(),
    vi = lang === "vi";
  const [month, setMonth] = useState(currentMonth),
    [data, setData] = useState<LedgerData | null>(null),
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
  const [reopenSheetOpen, setReopenSheetOpen] = useState(false),
    [reopenReason, setReopenReason] = useState(""),
    [reopening, setReopening] = useState(false),
    [reopenError, setReopenError] = useState("");
  const closed = monthCloseState?.month === month && monthCloseState.state === "closed";
  const addButtonRef = useRef<HTMLButtonElement>(null),
    initializedMonthRef = useRef(""),
    loadRequestSequenceRef = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const requestedMonth = month;
      const requestSequence = ++loadRequestSequenceRef.current;
      setLoading(true);
      setError("");
      try {
        // Investments never fails the whole load(): its fetch/parse is wrapped so a
        // rejection (network error, abort) resolves to a sentinel instead of
        // propagating into the Promise.all below and taking data/payables/closed
        // down with it — its success/failure is applied independently, further down.
        const investmentPromise = (async () => {
          try {
            const response = await fetch(`/api/admin/ledger/investments?month=${requestedMonth}`, { cache: "no-store", signal });
            return { ok: response.ok, body: await response.json(), aborted: false };
          } catch (cause) {
            return { ok: false, body: null, aborted: (cause as Error).name === "AbortError" };
          }
        })();
        const [ledgerResponse, closeResponse, payableResponse, investmentResult] = await Promise.all([
          fetch(`/api/admin/ledger?month=${requestedMonth}`, {
            cache: "no-store",
            signal,
          }),
          fetch(`/api/admin/ledger/month-close?month=${requestedMonth}`, {
            cache: "no-store",
            signal,
          }),
          fetch(`/api/admin/ledger/payables?month=${requestedMonth}`, { cache: "no-store", signal }),
          investmentPromise,
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
        // Investments: same requestedMonth this call already validated itself against
        // (we're past the sequence/abort guard above, so this call is the current one).
        // A body.month mismatch is treated as a stale/no-op sub-response, not an error.
        const investmentBody = investmentResult.body as InvestmentsData & { code?: string };
        const investmentMonthMismatch = investmentResult.ok && investmentBody?.month && investmentBody.month !== requestedMonth;
        if (!investmentMonthMismatch) {
          if (investmentResult.ok && investmentBody && typeof investmentBody.configured === "boolean") {
            setInvestments(investmentBody);
            setInvestmentsError(null);
          } else if (!investmentResult.aborted) {
            setInvestments(null);
            setInvestmentsError({
              month: requestedMonth,
              message: vi
                ? "Không thể tải tình hình vốn góp. Vui lòng thử lại sau."
                : "투자금 현황을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
            });
          }
        }
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
        if (!signal?.aborted && requestSequence === loadRequestSequenceRef.current) setLoading(false);
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
  const groups = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase(),
      byDate = new Map<string, DateGroup>();
    for (const entry of data?.entries ?? []) {
      if (filter === "income" && entry.direction !== "income") continue;
      if (filter === "expense" && entry.direction !== "expense") continue;
      if (filter === "manual" && entry.origin !== "manual") continue;
      if (filter === "pending" && entry.status !== "pending") continue;
      if (
        keyword &&
        !`${entryDisplayTitle(entry, lang)} ${entryMeta(entry, lang)} ${entry.accountName ?? ""} ${entry.categoryName ?? ""}`
          .toLocaleLowerCase()
          .includes(keyword)
      )
        continue;
      const group = byDate.get(entry.businessDate) ?? {
        date: entry.businessDate,
        rows: [],
        income: 0,
        expense: 0,
      };
      group.rows.push(entry);
      // Net corrections/reversals into the day subtotal via economicEffectSign
      // without touching the row's own displayed (always-positive) amount.
      const subtotal = entryDisplaySubtotal(entry);
      group.income += subtotal.income;
      group.expense += subtotal.expense;
      byDate.set(entry.businessDate, group);
    }
    for (const group of byDate.values()) {
      group.rows.sort((a, b) => a.sortTimestamp - b.sortTimestamp);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [data?.entries, filter, lang, search]);
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
  const payableParties = payables?.parties ?? [];
  const activeInvestments = investments && investments.month === month ? investments : null;
  const todayKey = todayDate();
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
        ...new Set(data.entries.map((entry) => entry.businessDate)),
      ].sort(),
      today = todayDate(),
      defaultDate = dates.includes(today) ? today : dates.at(-1);
    setExpandedDates(defaultDate ? new Set([defaultDate]) : new Set());
    setHistoryExpanded(false);
    initializedMonthRef.current = month;
  }, [data, month]);
  function shiftMonth(delta: number) {
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + delta);
    // Flip to the loading UI in the same render as the month switch itself (batched
    // with setMonth), so there is no in-between frame where the new month's title
    // could paint next to the previous month's still-attached numbers.
    setLoading(true);
    setMonth(date.toISOString().slice(0, 7));
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
      const draft = {
        item,
        resolution: selected.defaultResolution ?? "immediate",
        categoryId: String(item.categoryId ?? ""),
        fundAccountId: String(selected.defaultFundAccountId ?? ""),
        memo: "",
      };
      setCandidateDraft(draft);
    }
  }
  async function resolveCandidate() {
    if (!selected || !candidateDraft?.item.candidateId) return;
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
              partyId: selected.partyId,
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
        `${vi ? "Không thể ghi sổ." : "반영하지 못했습니다."} ${(cause as Error).message}`,
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
  function renderDateGroup(group: DateGroup) {
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
            {group.income > 0 ? <><i aria-hidden>·</i><b className={styles.dateIncome}>{vi ? "Thu" : "수입"} {money(group.income)}</b></> : null}
            {group.expense > 0 ? <><i aria-hidden>·</i><b className={styles.dateExpense}>{vi ? "Chi" : "지출"} {money(group.expense)}</b></> : null}
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
              <button
                type="button"
                className={styles.entryRow}
                key={entry.id}
                onClick={() => void openEntry(entry)}
              >
                <span
                  className={`${styles.direction} ${styles[entry.direction]}`}
                >
                  {entry.direction === "income"
                    ? vi
                      ? "Thu"
                      : "수입"
                    : entry.direction === "expense"
                      ? vi
                        ? "Chi"
                        : "지출"
                      : vi
                        ? "Chuyển"
                        : "이체"}
                </span>
                <span className={`${styles.accountBadge} ${isPayableAccount(entry.accountName) ? styles.accountBadgePayable : ""}`}>
                  {accountBadgeLabel(entry.accountName,lang,entry)}
                </span>
                <span className={styles.entryMain}>
                  <strong>{entryDisplayTitle(entry, lang)}</strong>
                  <span> · {entryMeta(entry, lang)}</span>
                </span>
                {entry.status === "pending" ? (
                  <span className={styles.pendingBadge}>
                    {vi ? "Cần xác nhận" : "확인 필요"}
                  </span>
                ) : null}
                {entry.requiresCorrection ? (
                  <span className={styles.correctionBadge}>
                    {vi ? "Cần điều chỉnh" : "정정 필요"}
                  </span>
                ) : null}
                <span className={styles.amountStack}>
                  {entry.displayTime ? <small>{entry.displayTime}</small> : null}
                  <strong
                    className={
                      entry.direction === "income"
                        ? styles.amountIncome
                        : entry.direction === "expense"
                          ? styles.amountExpense
                          : styles.amountTransfer
                    }
                  >
                    {entry.direction === "income"
                      ? "+"
                      : entry.direction === "expense"
                        ? "−"
                        : ""}
                    {money(entry.amount)}
                  </strong>
                </span>
                <span aria-hidden className={styles.chevron}>
                  ›
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
                setMonth(event.target.value);
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
        {data && data.month === month && data.inventoryProjectionIssues?.length ? <div role="status">
          <strong>{vi ? "Các giao dịch nhập kho cần kiểm tra" : "입고 장부 반영 확인 필요"}</strong>
          {data.inventoryProjectionIssues.map(issue => <p key={issue.inventoryLogId}>
            {vi ? "Nhập kho" : "입고 기록"} #{issue.inventoryLogId}: {issue.code}
          </p>)}
        </div> : null}
        {notice ? (
          <p className={styles.success} role="status">
            {notice}
          </p>
        ) : null}
        {data?.month === month && monthCloseState?.month === month && monthCloseState.state !== "open" ? (
          <section className={`${styles.monthCloseCard} ${monthCloseState.state === "reopened" ? styles.monthCloseReopened : ""}`}
            aria-label={vi ? "Trạng thái chốt sổ" : "월마감 상태"}>
            <div className={styles.monthCloseText}>
              <strong>{monthCloseState.state === "closed"
                ? vi ? `Sổ tháng ${Number(month.slice(5, 7))} đã chốt` : `${Number(month.slice(5, 7))}월 장부 마감됨`
                : vi ? `Đang kiểm tra lại tháng ${Number(month.slice(5, 7))}` : `${Number(month.slice(5, 7))}월 재검토 중`}</strong>
              <p>{monthCloseState.state === "closed"
                ? vi ? `Đã chốt lần ${monthCloseState.revision ?? 1} · Mở lại để sửa sổ.`
                  : `${monthCloseState.revision ?? 1}차 마감 · 수정하려면 마감을 다시 열어야 합니다.`
                : vi ? `Bản chốt lần ${monthCloseState.revision ?? 1} được lưu giữ. Hiện có thể sửa sổ.`
                  : `이전 ${monthCloseState.revision ?? 1}차 마감본은 보존됨 · 현재 수정 가능합니다.`}</p>
            </div>
            {monthCloseState.state === "closed"
              ? <button type="button" className={styles.monthCloseAction}
                  onClick={() => { setReopenError(""); setReopenSheetOpen(true); }}>
                  {vi ? "Mở lại sổ" : "마감 다시 열기"}
                </button>
              : <Link className={styles.monthCloseAction} href={`/admin/ledger/month-close?month=${month}`}>
                  {vi ? "Quản lý chốt sổ" : "월마감 관리"}
                </Link>}
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
                <strong>{money(data.summary.income)}</strong>
              </article>
              <article className={`${styles.summaryCard} ${styles.expenseCard}`}>
                <span className={styles.summaryLabel}>
                  <i aria-hidden="true">💸</i>
                  {vi ? "Chi" : "지출"}
                </span>
                <strong>{money(data.summary.displayedExpense)}</strong>
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
              {payableParties.length ? (
                <div className={styles.payableParties} id="payable-parties-list">{payableParties.map((party) => <button type="button" key={party.partyId} onClick={() => setPayableParty({...party,viewMonth:month})}>
                  <span className={styles.payablePartyMain}><span className={styles.partnerTypeBadge}>{partnerTypeLabel(party.partnerType,lang)}</span><span className={styles.payablePartyName}>{party.partyName}</span>
                    <small className={styles.payablePartyPeriod}>{vi ? `Phát sinh T${Number(month.slice(5,7))}` : `${Number(month.slice(5,7))}월 외상`}: {payableNumber(party.periodPurchases)} · {vi ? `Thanh toán T${Number(month.slice(5,7))}` : `${Number(month.slice(5,7))}월 지급`}: {payableNumber(party.periodPayments)}</small>
                  </span><strong aria-label={vi ? "Công nợ cuối tháng" : "월말 미납"}>{money(party.closingOutstanding)}</strong><small>{party.openCount}{vi ? " khoản" : "건"}</small><i aria-hidden>›</i>
                </button>)}</div>
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
                    ["monthlySettledGross",vi?"✅ Đã hoàn tất":"✅ 정산완료"],
                    ["monthlyUnreconciledGross",vi?"⏳ Chưa quyết toán":"⏳ 미정산"],
                    ["monthlySettlementDifference",vi?"💸 Phí/chênh lệch":"💸 수수료/차액"],
                  ] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{cardSettlement?.month===month&&cardSettlementError?.month!==month?money(cardSettlement.summary[key]):"-"}</dd></div>)}
                </dl>
                {cardSettlementError?.month===month?<p role="alert" className={styles.error}>{cardSettlementError.message}</p>:cardSettlement?.month!==month?<p className={styles.statusHint}>{vi?"Đang tải tình hình thẻ…":"카드 정산 현황을 불러오는 중입니다…"}</p>:null}
                <div className={styles.statusActions}><p className={styles.statusHint}>{vi?"Đăng ký tiền vào và kết nối doanh thu tại trang chi tiết.":"입금 등록과 매출 연결은 상세 페이지에서 진행합니다."}</p><Link href="/admin/ledger/card-settlements" className={styles.statusDetailLink}>{vi?"Xem chi tiết":"상세 보기"} ›</Link></div>
              </div>:null}
            </section>
            <section className={styles.statusCard} aria-labelledby="investment-title">
              <button type="button" className={styles.payableToggle} aria-expanded={investmentExpanded} aria-controls="investment-body" onClick={()=>setInvestmentExpanded(value=>!value)}>
                <div className={styles.payableHeading}>
                  <h2 id="investment-title">💼 {vi?"Tình hình vốn góp":"투자금 현황"} ({vi?`T${Number(month.slice(5,7))}`:`${Number(month.slice(5,7))}월`})</h2>
                  <strong aria-label={vi?"Lũy kế vốn góp cuối tháng":"월말 누적 투자금"}>
                    {activeInvestments ? (activeInvestments.configured ? money(activeInvestments.summary.closingCumulative) : (vi?"Chưa thiết lập":"미설정")) : "-"}
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
                    <dl className={styles.payableMonthTotals}>
                      <div><dt>🏁 {vi?"Lũy kế đầu tháng":"월초 누적"}</dt><dd>{money(activeInvestments.summary.openingCumulative)}</dd></div>
                      <div><dt>➕ {vi?"Góp vốn tháng này":"당월 추가투자"}</dt><dd>{activeInvestments.summary.periodContribution>0?"+":""}{money(activeInvestments.summary.periodContribution)}</dd></div>
                      <div><dt>🛠️ {vi?"Điều chỉnh tháng này":"당월 조정"}</dt><dd>{activeInvestments.summary.periodAdjustment>0?"+":""}{money(activeInvestments.summary.periodAdjustment)}</dd></div>
                      <div><dt>💼 {vi?"Lũy kế cuối tháng":"월말 누적"}</dt><dd>{money(activeInvestments.summary.closingCumulative)}</dd></div>
                    </dl>
                    {activeInvestments.events.length ? (
                      <div className={styles.itemList}>
                        {activeInvestments.events.map((event) => (
                          <article key={event.investmentId}>
                            <span className={styles.itemDescription}>
                              <strong>{formatDate(event.businessDate, lang)} · {event.participantName}</strong>
                              <span> · {investmentEntryTypeLabel(event.entryType, lang)}{investmentEventAccountSuffix(event, lang)}</span>
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
                {(
                  [
                    ["all", vi ? "Tất cả" : "전체"],
                    ["income", vi ? "Thu" : "수입"],
                    ["expense", vi ? "Chi" : "지출"],
                    ["manual", vi ? "Thủ công" : "수동"],
                    ["pending", vi ? "Cần xác nhận" : "확인 필요"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
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
        {selected ? (
          <EntryDetailSheet
            lang={lang}
            entry={selected}
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
            onConfirmedEdited={async (transactionId) => {
              const fresh = await load();
              const refreshed = fresh?.entries.find((entry) =>
                entry.transactionId === transactionId ||
                entry.items.some((item) => item.transactionId === transactionId),
              );
              if (refreshed) setSelected(refreshed);
              else setSelected(null);
              setNotice(vi ? "Đã cập nhật giao dịch." : "거래를 수정했습니다.");
            }}
            onClose={() => {
              setSelected(null);
              setCandidateDraft(null);
            }}
          />
        ) : null}
        {payableParty && data && payables?.month === month && payableParty.viewMonth === month ? (
          month === currentMonth()
            ? <PayablePartySheet lang={lang} party={payableParty} accounts={businessAccounts} onClose={() => setPayableParty(null)} onPaid={async () => { setPayableParty(null); await load(); setNotice(vi ? "Đã thanh toán các ngày đã chọn." : "선택 일자의 미납금을 결제했습니다."); }} />
            : <HistoricalPayablePartySheet lang={lang} month={month} party={payableParty} rows={payables.payables.filter(row => Number(row.party_id) === payableParty.partyId)} onClose={() => setPayableParty(null)} />
        ) : null}
      </main>
    </Container>
  );
}

function EntryDetailSheet({
  lang,
  entry,
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
  onClose,
}: {
  lang: "ko" | "vi";
  entry: LedgerEntry;
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
  onConfirmedEdited: (transactionId: number) => Promise<void>;
  onClose: () => void;
}) {
  const vi = lang === "vi";
  const confirmedInventory = entry.drilldown === "inventory" && entry.status === "confirmed";
  const confirmedMeal = entry.drilldown === "meal" && entry.status === "confirmed";
  const [editMode,setEditMode]=useState(false),[editDraft,setEditDraft]=useState<ConfirmedEditDraft|null>(null),[editError,setEditError]=useState(""),[editSaving,setEditSaving]=useState(false);
  const [mealDraft,setMealDraft]=useState<MealAdjustDraft|null>(null),[mealError,setMealError]=useState("");
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
      closeLabel={vi ? "Đóng" : "닫기"}
      saving={saving||editSaving}
      onClose={onClose}
      footer={
        <div className={styles.detailFooter}>
          {confirmedInventory ? <button type="button" disabled={saving||editSaving} onClick={()=>{setEditMode(value=>!value);setEditDraft(null);setEditError("")}} style={{...primaryButtonStyle,width:"100%"}}>{editMode?(vi?"Kết thúc chỉnh sửa":"수정 종료"):(vi?"Sửa":"수정")}</button>:null}
          {confirmedMeal ? <button type="button" disabled={saving||editSaving||closed} onClick={()=>{setMealDraft(value=>value?null:{finalAmount:String(entry.effectiveAmount??entry.amount),reason:""});setMealError("")}} style={{...primaryButtonStyle,width:"100%"}}>{mealDraft?(vi?"Đóng chỉnh sửa":"수정 닫기"):(vi?"Sửa tiền ăn":"식대 수정")}</button>:null}
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
        <div className={styles.detailTop}>
          <strong>🤝 {entryDisplayTitle(entry, lang)}</strong>
          <span className={styles.detailStatus}>
            {entry.status === "pending" || entry.requiresCorrection ? "⚠️" : "✅"}{" "}
            {entry.status === "pending"
              ? vi ? "Cần xác nhận" : "확인 필요"
              : entry.requiresCorrection
                ? vi ? "Cần điều chỉnh" : "정정 필요"
                : vi ? "Đã ghi sổ" : "반영 완료"}
          </span>
        </div>
        <div className={styles.detailMain}>
          <span>{directionEmoji(entry.direction)} {directionLabel(entry.direction, lang)}</span>
          <strong className={styles.detailAmount}>{money(entry.amount)}</strong>
        </div>
        <span className={styles.detailMeta}>
          📅 {formatDate(entry.businessDate, lang)} · 🏦{" "}
          {entry.accountName ?? (vi ? "Không có tài khoản" : "계정 없음")}
        </span>
      </div>
      {message ? (
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
            ]}
          />
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
                  {categories
                    .filter((row) => row.kind === "expense" && row.parent_id !== null)
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
        if(!entry.transactionId)return;
        setEditSaving(true);setMealError("");
        try{const response=await fetch(`/api/admin/ledger/transactions/${entry.transactionId}/meal-adjust`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({finalAmount:mealDraft.finalAmount,reason:mealDraft.reason})}),body=await response.json();if(!response.ok)throw new Error(body.code??"MEAL_ADJUST_FAILED");setMealDraft(null);await onConfirmedEdited(entry.transactionId)}catch(cause){const code=(cause as Error).message;setMealError(code==="ORIGINAL_MONTH_CLOSED"?(vi?"Không thể sửa giao dịch của tháng đã khóa.":"마감된 월의 거래는 일반 수정할 수 없습니다."):`${vi?"Không thể sửa tiền ăn.":"식대를 수정하지 못했습니다."} ${code}`)}finally{setEditSaving(false)}
      }}/>:null}
      {confirmedMeal&&closed?<p className={styles.policyNote}>{vi?"Không thể sửa giao dịch của tháng đã khóa.":"마감된 월의 거래는 일반 수정할 수 없습니다."}</p>:null}
      {entry.status === "confirmed" && entry.origin === "auto" ? (
        <p className={styles.policyNote}>
          {vi
            ? "Ảnh chụp dữ liệu nguồn được giữ nguyên. Thay đổi trong tháng đã khóa được xử lý theo chính sách điều chỉnh sổ hiện hành."
            : "원본 snapshot은 보존됩니다. 마감된 월의 변경은 기존 장부 정정 정책으로 처리됩니다."}
        </p>
      ) : null}
    </BarSheet>
  );
}

function MealAdjustmentEditor({lang,draft,setDraft,saving,error,onSave}:{lang:"ko"|"vi";draft:MealAdjustDraft;setDraft:(draft:MealAdjustDraft|null)=>void;saving:boolean;error:string;onSave:()=>Promise<void>}){
  const vi=lang==="vi";
  return <div className={styles.candidateEditor}>
    <div className={styles.editorTitle}><h3>✏️ {vi?"Sửa tiền ăn nhân viên":"직원 식대 수정"}</h3><button type="button" disabled={saving} onClick={()=>setDraft(null)}>{vi?"Hủy":"취소"}</button></div>
    <BarField label={vi?"Số tiền ăn cuối cùng":"최종 식대 금액"} required compact>{({id})=><input id={id} inputMode="decimal" value={formatLedgerDecimalAmount(draft.finalAmount)} onChange={event=>setDraft({...draft,finalAmount:sanitizeLedgerDecimalAmount(event.target.value)})} style={keepingInputStyle}/>}</BarField>
    <BarField label={vi?"Lý do chỉnh sửa":"수정 사유"} required compact>{({id})=><input id={id} value={draft.reason} onChange={event=>setDraft({...draft,reason:event.target.value})} style={keepingInputStyle} placeholder={vi?"Ví dụ: thêm 1 nhân viên đến muộn":"예: 18시 이후 추가 출근 1명"}/>}</BarField>
    <p className={styles.editorHelp}>{vi?"Hệ thống tự tính phần chênh lệch và điều chỉnh tiền mặt cửa hàng.":"차액과 매장 현금 조정은 자동으로 계산됩니다."}</p>
    {error?<p className={styles.error} role="alert">{error}</p>:null}
    <button type="button" disabled={saving||!draft.finalAmount||!draft.reason.trim()} onClick={()=>void onSave()} style={{...primaryButtonStyle,width:"100%"}}>{saving?(vi?"Đang lưu…":"저장 중…"):(vi?"Lưu":"저장")}</button>
  </div>
}

function ConfirmedInventoryEditor({lang,draft,setDraft,accounts,categories,saving,error,onSave}:{lang:"ko"|"vi";draft:ConfirmedEditDraft;setDraft:(draft:ConfirmedEditDraft|null)=>void;accounts:Account[];categories:Category[];saving:boolean;error:string;onSave:()=>Promise<void>}){
  const vi=lang==="vi",paid=(draft.item.paidAmount??0)>0;
  return <div className={styles.candidateEditor}>
    <div className={styles.editorTitle}><h3>✏️ {draft.item.name}</h3><button type="button" disabled={saving} onClick={()=>setDraft(null)}>{vi?"Hủy":"취소"}</button></div>
    <BarSegmentedControl label={vi?"Phân loại thanh toán":"결제 구분"} value={draft.paymentMode} disabled={saving||paid} onChange={paymentMode=>setDraft({...draft,paymentMode})} options={[{value:"immediate",label:vi?"Trả trước":"선결제"},{value:"payable",label:vi?"Trả sau":"후불"}]}/>
    {paid?<p className={styles.error}>{vi?"Khoản công nợ đã được thanh toán một phần hoặc toàn bộ nên không thể sửa.":"일부 또는 전액 결제된 미납 거래는 수정할 수 없습니다."}</p>:null}
    <div className={styles.candidateFields}><BarField label={vi?"Danh mục":"카테고리"} required compact>{({id})=><select id={id} value={draft.categoryId} onChange={event=>setDraft({...draft,categoryId:event.target.value})} style={keepingInputStyle}>{categories.filter(row=>row.kind==="expense").map(row=><option key={row.id} value={row.id}>{manualExpenseCategoryLabel(row.name,lang)}</option>)}</select>}</BarField><BarField label={vi?"Số tiền":"금액"} required compact>{({id})=><input id={id} inputMode="decimal" value={formatLedgerDecimalAmount(draft.amount)} onChange={event=>setDraft({...draft,amount:sanitizeLedgerDecimalAmount(event.target.value)})} style={keepingInputStyle}/>}</BarField></div>
    {draft.paymentMode==="immediate"?<div className={styles.candidateSingle}><AccountField lang={lang} label={`🏦 ${vi?"Tài khoản chi":"출금 계정"}`} value={draft.fundAccountId} setValue={fundAccountId=>setDraft({...draft,fundAccountId})} accounts={accounts.filter(row=>row.is_active&&row.is_business_fund&&row.type!=="card_clearing")}/></div>:<div className={styles.candidateSingle}><BarField label={vi?"Ngày đến hạn":"지급 기한"} compact>{({id})=><input id={id} type="date" value={draft.dueDate} onChange={event=>setDraft({...draft,dueDate:event.target.value})} style={keepingInputStyle}/>}</BarField></div>}
    <BarField label={vi?"Ghi chú":"메모"} compact>{({id})=><input id={id} value={draft.memo} onChange={event=>setDraft({...draft,memo:event.target.value})} style={keepingInputStyle}/>}</BarField>
    <BarField label={vi?"Lý do chỉnh sửa":"수정 사유"} required compact>{({id})=><input id={id} required value={draft.reason} onChange={event=>setDraft({...draft,reason:event.target.value})} style={keepingInputStyle}/>}</BarField>
    {error?<p className={styles.error} role="alert">{error}</p>:null}
    <button type="button" disabled={saving||paid||!draft.categoryId||!draft.amount||!draft.reason.trim()||(draft.paymentMode==="immediate"&&!draft.fundAccountId)} onClick={()=>void onSave()} style={{...primaryButtonStyle,width:"100%"}}>{saving?(vi?"Đang lưu…":"저장 중…"):(vi?"Lưu chỉnh sửa":"수정 저장")}</button>
  </div>
}

function PayableMonthTotals({summary,vi}:{summary?:PayablePeriodSummary;vi:boolean}) {
  const fields = [["openingOutstanding",vi?"↪️ Nợ chuyển tháng trước":"↪️ 전월 이월 미납"],["periodPurchases",vi?"📦 Phát sinh tháng":"📦 당월 외상 발생"],["periodPayments",vi?"💸 Thanh toán tháng":"💸 당월 지급"],["closingOutstanding",vi?"🧾 Công nợ cuối tháng":"🧾 월말 미납"]] as const;
  return <dl className={styles.payableMonthTotals}>{fields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{summary?money(summary[key]):"-"}</dd></div>)}</dl>;
}

function HistoricalPayablePartySheet({lang,month,party,rows,onClose}:{lang:"ko"|"vi";month:string;party:PayableParty;rows:PayableRow[];onClose:()=>void}) {
  const vi=lang==="vi";
  return <BarSheet kind="full" compact topAligned comfortableTop title={`${month} · ${vi?"Công nợ cuối tháng":"월말 미납 상세"}`} closeLabel={vi?"Đóng":"닫기"} saving={false} onClose={onClose} footer={<button type="button" onClick={onClose} style={{...secondaryButtonStyle,width:"100%"}}>{vi?"Đóng":"닫기"}</button>}>
    <h3>{party.partyName}</h3>
    <p role="status">{vi?"Chỉ xem số dư tại cuối tháng đã chọn. Không thể thanh toán từ lịch sử.":"선택월 말 기준 잔액을 보여주는 읽기 전용 상세입니다. 과거 조회에서는 결제할 수 없습니다."}</p>
    <PayableMonthTotals summary={party} vi={vi}/>
    <div className={styles.payableItems}>{[...rows].sort((a,b)=>(a.expense?.business_date??"").localeCompare(b.expense?.business_date??"")||a.id-b.id).map(row=><span key={row.id}><em>{row.expense?.business_date} · {payableItemLabel(row,vi)}</em><b>{money(row.outstandingAmount)}</b></span>)}</div>
    {!rows.length?<p className={styles.payableEmpty}>{vi?"Không có công nợ cuối tháng.":"선택월 말 미납금이 없습니다."}</p>:null}
  </BarSheet>;
}

function PayablePartySheet({ lang, party, accounts, onClose, onPaid }: {
  lang:"ko"|"vi"; party:PayableParty; accounts:Account[]; onClose:()=>void; onPaid:()=>Promise<void>;
}) {
  const vi=lang==="vi", initial=localTime();
  const [detail,setDetail]=useState<PayableDetail|null>(null),[selectedDates,setSelectedDates]=useState<Set<string>>(()=>new Set()),[expanded,setExpanded]=useState<Set<string>>(()=>new Set()),[accountId,setAccountId]=useState(""),[date,setDate]=useState(initial.slice(0,10)),[time,setTime]=useState(initial.slice(11,16)),[memo,setMemo]=useState(""),[saving,setSaving]=useState(false),[error,setError]=useState("");
  const loadDetail=useCallback(async()=>{setError("");try{const response=await fetch(`/api/admin/ledger/payables/${party.partyId}`,{cache:"no-store"}),body=await response.json();if(!response.ok)throw new Error(body.code);setDetail(body)}catch{setError(vi?"Không thể tải chi tiết công nợ.":"미납 상세를 불러오지 못했습니다.")}},[party.partyId,vi]);
  useEffect(()=>{void loadDetail()},[loadDetail]);
  const groups=useMemo(()=>{const map=new Map<string,PayableRow[]>();for(const row of detail?.payables??[]){if(row.outstandingAmount<=0)continue;const key=row.expense?.business_date??"";map.set(key,[...(map.get(key)??[]),row])}return [...map.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([businessDate,rows])=>({businessDate,rows,total:rows.reduce((sum,row)=>sum+row.outstandingAmount,0)}))},[detail]);
  const selectedGroups=groups.filter(group=>selectedDates.has(group.businessDate)),selectedTotal=selectedGroups.reduce((sum,group)=>sum+group.total,0),selectedPayables=selectedGroups.flatMap(group=>group.rows);
  async function pay(){if(saving||!accountId||!selectedPayables.length)return;setSaving(true);setError("");try{const response=await fetch("/api/admin/ledger/payables/pay",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({partyId:party.partyId,fundAccountId:Number(accountId),occurredAt:`${date}T${time}:00+07:00`,amount:selectedTotal,allocations:selectedPayables.map(row=>({payableId:row.id,allocatedAmount:row.outstandingAmount})),memo:memo||null})}),body=await response.json();if(!response.ok)throw new Error(body.code);setSelectedDates(new Set());await onPaid()}catch(cause){setError(`${vi?"Không thể thanh toán.":"결제하지 못했습니다."} ${(cause as Error).message}`)}finally{setSaving(false)}}
  return <BarSheet kind="full" compact topAligned comfortableTop fillAvailable containedBody title={vi?"Chi tiết công nợ":"미납금 상세"} closeLabel={vi?"Đóng":"닫기"} saving={saving} onClose={onClose} footer={<div className={styles.detailFooter}><button type="button" disabled={saving||!accountId||!selectedPayables.length} onClick={()=>void pay()} style={{...primaryButtonStyle,width:"100%"}}>{saving?(vi?"Đang thanh toán…":"결제 중…"):(vi?`Thanh toán ${selectedDates.size} ngày đã chọn`:`선택 일자 ${selectedDates.size}건 결제`)}</button><button type="button" disabled={saving} onClick={onClose} style={{...secondaryButtonStyle,width:"100%"}}>{vi?"Đóng":"닫기"}</button></div>}>
    <div className={styles.payableSheetBody}>
    <div className={styles.payableDetailHeader}><strong>🤝 {party.partyName}</strong><span>{vi?"Tổng công nợ":"총 미납"} <b>{money(detail?.totalOutstanding??party.outstandingAmount)}</b></span></div>
    {error?<p className={styles.error} role="alert">{error}</p>:null}
    <div className={styles.payableDates}>{groups.map(group=>{const open=expanded.has(group.businessDate),checked=selectedDates.has(group.businessDate);return <article key={group.businessDate}><div className={styles.payableDateRow}><input type="checkbox" checked={checked} aria-label={`${formatDate(group.businessDate,lang)} ${vi?"chọn":"선택"}`} onChange={()=>setSelectedDates(current=>{const next=new Set(current);if(next.has(group.businessDate))next.delete(group.businessDate);else next.add(group.businessDate);return next})}/><button type="button" aria-expanded={open} onClick={()=>setExpanded(current=>{const next=new Set(current);if(next.has(group.businessDate))next.delete(group.businessDate);else next.add(group.businessDate);return next})}><span>📅 {formatDate(group.businessDate,lang)}</span><small>{group.rows.length}{vi?" khoản":"건"}</small><strong>{money(group.total)}</strong><i aria-hidden>›</i></button></div>{open?<div className={styles.payableItems}>{group.rows.map(row=><span key={row.id}><em>📦 {payableItemLabel(row,vi)}</em><b>{money(row.outstandingAmount)}</b></span>)}</div>:null}</article>})}</div>
    {!groups.length&&!error?<p className={styles.payableEmpty}>{vi?"Không có công nợ chưa thanh toán.":"미납금이 없습니다."}</p>:null}
    <div className={styles.paymentForm}><div className={styles.selectedTotal}><span>{vi?"Công nợ đã chọn":"선택 미납금"}</span><strong>{money(selectedTotal)}</strong></div><div className={styles.manualSingle}><AccountField lang={lang} label={`🏦 ${vi?"Tài khoản chi":"출금 계정"}`} value={accountId} setValue={setAccountId} accounts={accounts}/></div><div className={styles.manualRow}><BarField label={`📅 ${vi?"Ngày thanh toán":"결제일"}`} required compact>{({id})=><input id={id} type="date" value={date} onChange={event=>setDate(event.target.value)} style={keepingInputStyle}/>}</BarField><BarField label={`🕒 ${vi?"Thời gian":"시간"}`} required compact>{({id})=><input id={id} type="time" value={time} onChange={event=>setTime(event.target.value)} style={keepingInputStyle}/>}</BarField></div><BarField label={`📝 ${vi?"Ghi chú":"메모"}`} compact>{({id})=><input id={id} value={memo} onChange={event=>setMemo(event.target.value)} style={keepingInputStyle}/>}</BarField></div>
    </div>
  </BarSheet>
}

function payableItemLabel(row:PayableRow,vi:boolean){const snapshot=row.expense?.display_snapshot??row.expense?.source_snapshot;return String((vi?snapshot?.item_name_vi:null)??snapshot?.item_name??snapshot?.itemName??snapshot?.name??(vi?"Mặt hàng tồn kho":"재고 품목"))}

function ManualEntrySheet({
  lang,
  data,
  month,
  saving,
  setSaving,
  onClose,
  onSaved,
  returnFocusRef,
}: {
  lang: "ko" | "vi";
  data: LedgerData;
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
    [memo, setMemo] = useState(""),
    [reason, setReason] = useState(""),
    [error, setError] = useState("");
  const categories =
      type === "expense"
        ? data.categories
            .filter(isManualExpenseCategory)
            .sort(manualExpenseCategorySort)
        : data.categories.filter((row) => row.kind === "income"),
    accounts = data.accounts.filter((row) => row.is_active),
    selectedPartner = data.partners.find((row) => String(row.id) === partnerId);
  function changeType(next: EntryType) {
    setType(next);
    setCategoryId("");
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
      const response = await fetch("/api/admin/ledger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            amount: amountValue,
            occurredAt: `${occurredDate}T${occurredTime}:00+07:00`,
            recognitionMonth:
              type === "income" || type === "expense" ? `${month}-01` : null,
            categoryId:
              type === "income" || type === "expense"
                ? Number(categoryId)
                : null,
            partyId:
              type === "expense"
                ? (selectedPartner?.ledgerPartyId ?? null)
                : null,
            fromAccountId:
              type === "expense" ||
              type === "transfer" ||
              (type === "balance_adjustment" && Number(amount) < 0)
                ? Number(fromAccountId)
                : null,
            toAccountId:
              type === "income" ||
              type === "transfer" ||
              (type === "balance_adjustment" && Number(amount) >= 0)
                ? Number(toAccountId)
                : null,
            memo,
            reason,
          }),
        }),
        body = await response.json();
      if (!response.ok) throw new Error(body.code);
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
      (type === "balance_adjustment" && Number(amount) < 0),
    incoming =
      type === "income" ||
      type === "transfer" ||
      (type === "balance_adjustment" && Number(amount) >= 0);
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
          <div
            className={`${styles.manualRow} ${type === "income" || type === "expense" ? "" : styles.manualSingle}`}
          >
            <BarField label={`💵 ${vi ? "Số tiền" : "금액"}`} required compact>
              {({ id }) => (
                <input
                  id={id}
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
            {type === "income" || type === "expense" ? (
              <BarField
                label={`🏷️ ${vi ? "Danh mục" : "카테고리"}`}
                required
                compact
              >
                {({ id }) => (
                  <select
                    id={id}
                    required
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                    style={keepingInputStyle}
                  >
                    <option value="">{vi ? "Chọn" : "선택"}</option>
                    {categories.map((row) => (
                      <option key={row.id} value={row.id}>
                        {type === "expense"
                          ? manualExpenseCategoryLabel(row.name, lang)
                          : row.name}
                      </option>
                    ))}
                  </select>
                )}
              </BarField>
            ) : null}
          </div>
          <div className={styles.manualRow}>
            <BarField
              label={`📅 ${vi ? "Ngày phát sinh" : "발생일"}`}
              required
              compact
            >
              {({ id }) => (
                <input
                  id={id}
                  required
                  type="date"
                  value={occurredDate}
                  onChange={(event) => setOccurredDate(event.target.value)}
                  style={keepingInputStyle}
                />
              )}
            </BarField>
            <BarField
              label={`🕒 ${vi ? "Thời gian" : "시간"}`}
              required
              compact
            >
              {({ id }) => (
                <input
                  id={id}
                  required
                  type="time"
                  value={occurredTime}
                  onChange={(event) => setOccurredTime(event.target.value)}
                  style={keepingInputStyle}
                />
              )}
            </BarField>
          </div>
          <div
            className={`${styles.manualRow} ${type === "transfer" || type === "expense" ? "" : styles.manualSingle}`}
          >
            {outgoing ? (
              <AccountField
                lang={lang}
                label={`🏦 ${type === "balance_adjustment" ? (vi ? "Tài khoản điều chỉnh" : "조정 계정") : vi ? "Tài khoản chi" : "출금 계정"}`}
                value={fromAccountId}
                setValue={setFromAccountId}
                accounts={accounts}
              />
            ) : null}
            {incoming ? (
              <AccountField
                lang={lang}
                label={`🏦 ${type === "balance_adjustment" ? (vi ? "Tài khoản điều chỉnh" : "조정 계정") : vi ? "Tài khoản nhận" : "입금 계정"}`}
                value={toAccountId}
                setValue={setToAccountId}
                accounts={accounts}
              />
            ) : null}
            {type === "expense" ? (
              <BarField
                label={`🤝 ${vi ? "Đối tác (không bắt buộc)" : "거래처 (선택)"}`}
                compact
              >
                {({ id }) => (
                  <select
                    id={id}
                    value={partnerId}
                    onChange={(event) => setPartnerId(event.target.value)}
                    style={keepingInputStyle}
                  >
                    <option value="">{vi ? "Không có" : "없음"}</option>
                    {data.partners
                      .filter((row) => row.isActive)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                  </select>
                )}
              </BarField>
            ) : null}
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
  value,
  setValue,
  accounts,
}: {
  lang: "ko" | "vi";
  label: string;
  value: string;
  setValue: (value: string) => void;
  accounts: Account[];
}) {
  return (
    <BarField label={label} required compact>
      {({ id }) => (
        <select
          id={id}
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
function entryMeta(entry: LedgerEntry, lang: "ko" | "vi" = "ko") {
  if (entry.systemDisplay?.kind === "pos") {
    return lang === "vi"
      ? `${entry.systemDisplay.receiptCount.toLocaleString("vi-VN")} hóa đơn`
      : `영수증 ${entry.systemDisplay.receiptCount.toLocaleString("ko-KR")}건`;
  }
  if (entry.systemDisplay?.kind === "meal") return "";
  if (entry.systemDisplay?.kind === "inventory") {
    return lang === "vi"
      ? `${entry.systemDisplay.itemCount.toLocaleString("vi-VN")} mặt hàng`
      : `${entry.systemDisplay.itemCount.toLocaleString("ko-KR")}품목`;
  }
  if (entry.systemDisplay?.kind === "rent") return lang === "vi" ? "Tiền thuê" : "임대료";
  const vi = lang === "vi",
    subtitle = entry.subtitle.replace(/\s*·\s*확인 필요/g, "");
  return [
    subtitle,
    entry.origin === "manual" ? (vi ? "Thủ công" : "수동") : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
  if (display?.kind === "inventory" && display.partyMissing) {
    return lang === "vi" ? "Chưa chỉ định nhà cung cấp" : "거래처 미지정";
  }
  if (display?.kind === "rent") return lang === "vi" ? "Tiền thuê mặt bằng" : "매장 임대료";
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
  if (entry?.systemDisplay?.kind === "pos" && entry.systemDisplay.paymentBucket === "card") {
    return lang === "vi" ? "Thẻ" : "카드";
  }
  if (!accountName) return lang === "vi" ? "Chưa rõ" : "미지정";
  if (accountName === "매장 현금") return lang === "vi" ? "Tiền mặt" : "현금";
  if (accountName === "BABA 법인계좌") return lang === "vi" ? "Công ty" : "법인";
  if (accountName === "미지급") return lang === "vi" ? "Công nợ" : "미지급";
  if (accountName === "개인(Vương)" || accountName === "Vương 개인계좌 (BABA 소유분)") return "Vương";
  if (accountName === "개인(Cho)" || accountName === "Cho 개인계좌 (BABA 소유분)") return "Cho";
  return accountName;
}
function investmentEntryTypeLabel(entryType: InvestmentEntryType, lang: "ko" | "vi") {
  if (entryType === "opening") return lang === "vi" ? "Vốn góp ban đầu" : "기초 등록";
  if (entryType === "contribution") return lang === "vi" ? "Góp vốn thêm" : "추가 투자";
  return lang === "vi" ? "Điều chỉnh vốn góp" : "투자금 조정";
}
// contribution moves real funds, so it shows the account; opening/adjustment never
// create a movement (existing RPC contract) and must never appear to have one.
function investmentEventAccountSuffix(event: InvestmentEvent, lang: "ko" | "vi") {
  if (event.entryType === "contribution") return ` · ${accountBadgeLabel(event.fundAccountName, lang)}`;
  const noMovement = lang === "vi" ? "Không dịch chuyển quỹ" : "자금이동 없음";
  return event.reason ? ` · ${noMovement} · ${event.reason}` : ` · ${noMovement}`;
}
function directionEmoji(direction: LedgerEntry["direction"]) {
  return direction === "income" ? "💰" : direction === "expense" ? "💸" : "🔄";
}
function directionLabel(
  direction: LedgerEntry["direction"],
  lang: "ko" | "vi",
) {
  if (direction === "income") return lang === "vi" ? "Thu" : "수입";
  if (direction === "expense") return lang === "vi" ? "Chi" : "지출";
  return lang === "vi" ? "Chuyển tiền" : "이체";
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
