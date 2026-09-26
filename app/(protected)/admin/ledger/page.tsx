"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import { BarSheet } from "@/components/bar/keeping/KeepingUi";
import { getBusinessDate } from "@/lib/common/business-time";
import {
  buildDashboardReport,
  previousLedgerMonth,
  shiftLedgerMonth,
  type BreakdownChange,
  type DashboardLedgerData,
} from "@/lib/ledger/dashboard-report";
import { ledgerMonthHref, selectedLedgerMonth } from "@/lib/ledger/month-query";
import {
  buildProvisionalOperatingProfit,
  type CardSettlementSource,
  type PayrollOverviewSource,
  type ProvisionalOperatingProfit,
} from "@/lib/ledger/provisional-operating-profit";
import { useLanguage } from "@/lib/language-context";
import styles from "./ledger-dashboard.module.css";

const text = {
  ko: {
    monthInput: "조회 월",
    previousMonth: "이전 달",
    nextMonth: "다음 달",
    loading: "월간 경영 리포트를 불러오는 중입니다.",
    error: "월간 경영 리포트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
    income: "당월 수입",
    expense: "당월 지출",
    cashDifference: "수입·지출 차액",
    balance: "현재 보유금",
    monthEndBalance: "월말 보유금",
    incomeComposition: "수입 구성",
    expenseComposition: "지출 구성",
    cashFlow: "이번 달 자금 흐름",
    profitAndLossNote: "실제 입출금일이 아닌 해당 월에 발생한 수익·비용 기준",
    operatingIncome: "당월 영업수익",
    operatingExpense: "당월 영업비용",
    operatingProfit: "영업이익",
    provisionalOperatingProfit: "잠정 영업이익",
    provisionalNote: "현재까지 발생 기준 · 미확정 급여와 카드수수료 예상분 포함",
    ledgerExpense: "현재 장부비용",
    unrecognizedPayroll: "미반영 급여비용",
    cardFeeEstimate: "미정산 카드수수료 예상",
    provisionalExpense: "잠정 영업비용",
    provisional: "잠정",
    needsCheck: "계산 확인 필요",
    detail: "상세보기",
    provisionalDetailTitle: "잠정 영업이익 상세",
    operatingProfitDetailTitle: "영업이익 상세",
    close: "닫기",
    estimateUnavailable: "예상 불가",
    openingBalance: "월초 보유금",
    receivedIncome: "실제 유입",
    investment: "투자금 입·출금",
    otherAdjustment: "기타 자금조정",
    deficitToSurplus: "적자 → 흑자",
    surplusToDeficit: "흑자 → 적자",
    reconciliationWarning: "확인 필요 차이",
    cashExpense: "실제 현금지출",
    empty: "표시할 내역이 없습니다.",
    newItem: "신규",
  },
  vi: {
    monthInput: "Tháng báo cáo",
    previousMonth: "Tháng trước",
    nextMonth: "Tháng sau",
    loading: "Đang tải báo cáo quản trị tháng.",
    error: "Không thể tải báo cáo quản trị tháng. Vui lòng thử lại sau.",
    income: "Thu nhập tháng",
    expense: "Chi phí tháng",
    cashDifference: "Chênh lệch thu·chi",
    balance: "Tiền hiện có",
    monthEndBalance: "Tiền cuối tháng",
    incomeComposition: "Cơ cấu thu nhập",
    expenseComposition: "Cơ cấu chi phí",
    cashFlow: "Dòng tiền tháng này",
    profitAndLossNote: "Theo doanh thu·chi phí phát sinh trong tháng, không theo ngày thu chi thực tế",
    operatingIncome: "Doanh thu kinh doanh tháng",
    operatingExpense: "Chi phí kinh doanh tháng",
    operatingProfit: "Lợi nhuận hoạt động",
    provisionalOperatingProfit: "Lợi nhuận tạm tính",
    provisionalNote: "Tính đến hiện tại · gồm lương chưa chốt và phí thẻ ước tính",
    ledgerExpense: "Chi phí đã ghi sổ",
    unrecognizedPayroll: "Chi phí lương chưa ghi sổ",
    cardFeeEstimate: "Phí thẻ chưa quyết toán (ước tính)",
    provisionalExpense: "Chi phí tạm tính",
    provisional: "Tạm tính",
    needsCheck: "Cần kiểm tra",
    detail: "Chi tiết",
    provisionalDetailTitle: "Chi tiết lợi nhuận tạm tính",
    operatingProfitDetailTitle: "Chi tiết lợi nhuận hoạt động",
    close: "Đóng",
    estimateUnavailable: "Chưa ước tính được",
    openingBalance: "Tiền đầu tháng",
    receivedIncome: "Tiền thực thu",
    investment: "Tiền đầu tư vào·ra",
    otherAdjustment: "Điều chỉnh vốn khác",
    deficitToSurplus: "Lỗ → lãi",
    surplusToDeficit: "Lãi → lỗ",
    reconciliationWarning: "Chênh lệch cần kiểm tra",
    cashExpense: "Tiền thực chi",
    empty: "Không có dữ liệu để hiển thị.",
    newItem: "Mới",
  },
} as const;

const vietnameseCategoryNames: Record<string, string> = {
  "실제 매출입금": "Doanh thu thực nhận",
  "영업수입": "Thu nhập kinh doanh",
  "POS 매출": "Doanh thu POS",
  "기타 수입": "Thu nhập khác",
  "예금이자": "Lãi tiền gửi",
  "매입비": "Chi phí mua hàng",
  "식자재 매입": "Nguyên liệu thực phẩm",
  "주류 매입": "Đồ uống có cồn",
  "음료·BAR 재료": "Nguyên liệu đồ uống & BAR",
  "소모품·잡화": "Vật tư tiêu hao",
  "인건비": "Chi phí nhân sự",
  "공과금": "Điện nước",
  "임차·시설비": "Thuê & cơ sở vật chất",
  "일반관리비": "Chi phí quản lý chung",
  "선급·기타지출": "Chi trả trước & khác",
  "이월·기타조정": "Điều chỉnh chuyển kỳ & khác",
  "기타 실제지출": "Chi thực tế khác",
  "급여 지급": "Chi trả lương",
  "미배분 미지급금 지급": "Thanh toán công nợ chưa phân bổ",
  "선급비용 지급": "Chi phí trả trước",
  "잔액 조정": "Điều chỉnh số dư",
  "장부 정정": "Điều chỉnh sổ",
  "세부분류 없음": "Chưa phân loại chi tiết",
  "분류 미지정": "Chưa phân loại",
};

type ProvisionalSources = {
  payroll: PayrollOverviewSource | null;
  currentCard: CardSettlementSource | null;
  previousCard: CardSettlementSource | null;
};
type DashboardState = {
  month: string;
  current: DashboardLedgerData;
  previous: DashboardLedgerData;
  provisional: ProvisionalSources | null;
};

// A failed source becomes null so the base dashboard still renders and the
// provisional profit shows "needs check" instead of treating the cost as 0.
async function loadOptionalMonthBody<T>(url: string, month: string, signal: AbortSignal, pick: (body: Record<string, unknown>) => T) {
  try {
    const response = await fetch(url, { cache: "no-store", signal });
    const body = await response.json();
    return response.ok && body?.ok !== false && body?.month === month ? pick(body) : null;
  } catch {
    return null;
  }
}

function loadProvisionalSources(month: string, previousMonth: string, signal: AbortSignal): Promise<ProvisionalSources> {
  return Promise.all([
    loadOptionalMonthBody(`/api/admin/payroll/overview?month=${month}`, month, signal, (body) => body as PayrollOverviewSource),
    loadOptionalMonthBody(`/api/admin/ledger/card-settlements?month=${month}`, month, signal, (body) => (body.summary ?? null) as CardSettlementSource | null),
    loadOptionalMonthBody(`/api/admin/ledger/card-settlements?month=${previousMonth}`, previousMonth, signal, (body) => (body.summary ?? null) as CardSettlementSource | null),
  ]).then(([payroll, currentCard, previousCard]) => ({ payroll, currentCard, previousCard }));
}
type DashboardReportData = ReturnType<typeof buildDashboardReport>;
type DashboardText = (typeof text)["ko"] | (typeof text)["vi"];

const money = (amount: number) =>
  `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(amount))} ₫`;

const compactMoney = (amount: number) => {
  const absolute = Math.abs(amount);
  if (absolute < 1_000_000) return money(amount);
  const sign = amount < 0 ? "-" : "";
  return `${sign}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(absolute / 1_000_000)}m ₫`;
};

const categoryLabel = (name: string, lang: "ko" | "vi") => lang === "vi" ? vietnameseCategoryNames[name] ?? name : name;
const share = (amount: number, total: number) => total === 0 ? 0 : (amount / Math.abs(total)) * 100;
function LedgerDashboardContent() {
  const { lang } = useLanguage();
  const copy = text[lang];
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const month = selectedLedgerMonth(searchParams.get("month"), getBusinessDate().slice(0, 7));
  const previousMonth = previousLedgerMonth(month);
  const isCurrentMonth = month === getBusinessDate().slice(0, 7);
  const [dashboardState, setDashboardState] = useState<DashboardState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [expandedExpenses, setExpandedExpenses] = useState<Set<number>>(() => new Set());
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestSequence = ++requestSequenceRef.current;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        // Past months never load Payroll/card estimates.
        const provisionalPromise = isCurrentMonth ? loadProvisionalSources(month, previousMonth, controller.signal) : Promise.resolve(null);
        const [currentResponse, previousResponse] = await Promise.all([
          fetch(`/api/admin/ledger?month=${month}`, { cache: "no-store", signal: controller.signal }),
          fetch(`/api/admin/ledger?month=${previousMonth}`, { cache: "no-store", signal: controller.signal }),
        ]);
        const [currentBody, previousBody] = await Promise.all([
          currentResponse.json(),
          previousResponse.json(),
        ]);
        if (!currentResponse.ok || !previousResponse.ok) {
          throw new Error("DASHBOARD_LOAD_FAILED");
        }
        const provisional = await provisionalPromise;
        if (
          controller.signal.aborted ||
          requestSequence !== requestSequenceRef.current ||
          currentBody.month !== month ||
          previousBody.month !== previousMonth
        ) return;
        setDashboardState({
          month,
          current: currentBody as DashboardLedgerData,
          previous: previousBody as DashboardLedgerData,
          provisional,
        });
      } catch (cause) {
        if ((cause as Error).name !== "AbortError" && requestSequence === requestSequenceRef.current) setError(true);
      } finally {
        if (!controller.signal.aborted && requestSequence === requestSequenceRef.current) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      requestSequenceRef.current += 1;
    };
  }, [month, previousMonth, isCurrentMonth]);

  const report = useMemo(
    () => dashboardState?.month === month
      ? buildDashboardReport(dashboardState.current, dashboardState.previous)
      : null,
    [dashboardState, month],
  );
  const operatingResult = useMemo(
    () => dashboardState?.month === month
      ? buildProvisionalOperatingProfit({
        isCurrentMonth: isCurrentMonth && dashboardState.provisional !== null && dashboardState.current.fundsView.mode === "live",
        summary: dashboardState.current.summary,
        payroll: dashboardState.provisional?.payroll ?? null,
        currentCard: dashboardState.provisional?.currentCard ?? null,
        previousCard: dashboardState.provisional?.previousCard ?? null,
      })
      : null,
    [dashboardState, month, isCurrentMonth],
  );

  function selectMonth(nextMonth: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(nextMonth)) return;
    setLoading(true);
    setExpandedExpenses(new Set());
    router.push(ledgerMonthHref(pathname, searchParams.toString(), nextMonth), { scroll: false });
  }

  return <Container noPaddingTop><main className={styles.page}>
    <section className={styles.monthCard} aria-label={copy.monthInput}>
      <div className={styles.monthNavigation}>
        <button type="button" className={styles.monthButton} onClick={() => selectMonth(shiftLedgerMonth(month, -1))} aria-label={copy.previousMonth}>{lang === "vi" ? "Trước" : "이전"}</button>
        <input className={styles.monthInput} aria-label={copy.monthInput} type="month" value={month} onChange={(event) => selectMonth(event.target.value)} />
        <button type="button" className={styles.monthButton} onClick={() => selectMonth(shiftLedgerMonth(month, 1))} aria-label={copy.nextMonth}>{lang === "vi" ? "Sau" : "다음"}</button>
      </div>
    </section>

    {error ? <section role="alert" className={`${styles.statusCard} ${styles.error}`}>{copy.error}</section> : null}
    {loading && !report ? <div className={styles.skeleton} aria-label={copy.loading} /> : null}
    {report && operatingResult && dashboardState?.month === month ? <DashboardReport
      copy={copy}
      lang={lang}
      fundsMode={dashboardState.current.fundsView.mode}
      report={report}
      operatingResult={operatingResult}
      expandedExpenses={expandedExpenses}
      onToggleExpense={(id) => setExpandedExpenses((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      })}
    /> : null}
  </main></Container>;
}

function DashboardReport({ copy, lang, fundsMode, report, operatingResult, expandedExpenses, onToggleExpense }: {
  copy: DashboardText;
  lang: "ko" | "vi";
  fundsMode: DashboardLedgerData["fundsView"]["mode"];
  report: DashboardReportData;
  operatingResult: ProvisionalOperatingProfit;
  expandedExpenses: Set<number>;
  onToggleExpense: (id: number) => void;
}) {
  const [operatingDetailOpen, setOperatingDetailOpen] = useState(false);
  const detailButtonRef = useRef<HTMLButtonElement>(null);
  const detailButton = <button ref={detailButtonRef} type="button" className={styles.kpiDetailButton} aria-haspopup="dialog" onClick={() => setOperatingDetailOpen(true)}>{copy.detail} ›</button>;
  return <>
    <section className={styles.kpiGrid} aria-label="KPI">
      <KpiCard icon="💰" label={copy.income} amount={report.kpis.income} change={report.kpis.incomeChange} amountClass={styles.trendUp} />
      <KpiCard icon="💸" label={copy.expense} amount={report.kpis.expense} change={report.kpis.expenseChange} amountClass={styles.trendDown} />
      <KpiCard icon="📈" label={copy.cashDifference} amount={report.kpis.cashDifference} {...signedTrend(report.kpis.cashDifferenceChange, copy)} />
      {operatingResult.mode === "provisional"
        // Provisional vs. final profit are different bases, so no month-over-month %.
        ? <KpiCard icon="📊" label={copy.provisionalOperatingProfit} amount={operatingResult.operatingProfit} note={operatingResult.needsCheck ? copy.needsCheck : copy.provisional} trendDirection={operatingResult.needsCheck ? "down" : undefined} action={detailButton} />
        : <KpiCard icon="📊" label={copy.operatingProfit} amount={report.kpis.operatingProfit} {...signedTrend(report.kpis.operatingProfitChange, copy)} action={detailButton} />}
    </section>

    {operatingDetailOpen ? <OperatingProfitSheet copy={copy} report={report} operatingResult={operatingResult} returnFocusRef={detailButtonRef} onClose={() => setOperatingDetailOpen(false)} /> : null}

    <BreakdownCard icon="📊" title={copy.incomeComposition} total={report.kpis.income} rows={report.income} lang={lang} empty={copy.empty} newLabel={copy.newItem} />

    <section className={styles.reportCard}>
      <div className={styles.sectionHeader}><h2 className={styles.sectionTitle}><span className={styles.titleEmoji} aria-hidden="true">📉</span>{copy.expenseComposition}</h2><strong className={styles.sectionTotal}>{money(report.kpis.expense)}</strong></div>
      {report.expenses.length ? <div className={styles.breakdownList}>{report.expenses.map((row) => <ExpenseRow key={row.id} row={row} total={report.kpis.expense} lang={lang} newLabel={copy.newItem} expanded={expandedExpenses.has(row.id)} onToggle={() => onToggleExpense(row.id)} />)}</div> : <p className={styles.empty}>{copy.empty}</p>}
    </section>

    <section className={styles.reportCard}>
      <div className={styles.sectionHeader}><h2 className={styles.sectionTitle}><span className={styles.titleEmoji} aria-hidden="true">💵</span>{copy.cashFlow}</h2></div>
      <div className={styles.cashFlow}>
        <div className={styles.cashBalance}><span>{copy.openingBalance}</span><strong>{compactMoney(report.cashFlow.openingBalance)}</strong></div>
        <div className={styles.cashArrow}>↓</div>
        <CashLine sign="+" label={copy.receivedIncome} amount={report.cashFlow.receivedIncome} positive />
        <CashLine sign="−" label={copy.cashExpense} amount={report.cashFlow.actualCashOutflow} />
        <CashLine sign={report.cashFlow.investmentCashFlow < 0 ? "−" : "+"} label={copy.investment} amount={Math.abs(report.cashFlow.investmentCashFlow)} positive={report.cashFlow.investmentCashFlow >= 0} />
        <CashLine sign={report.cashFlow.otherFundAdjustment < 0 ? "−" : "+"} label={copy.otherAdjustment} amount={Math.abs(report.cashFlow.otherFundAdjustment)} positive={report.cashFlow.otherFundAdjustment >= 0} />
        {Math.abs(report.cashFlow.reconciliationDifference) >= 0.5 ? <CashLine sign={report.cashFlow.reconciliationDifference < 0 ? "−" : "+"} label={copy.reconciliationWarning} amount={Math.abs(report.cashFlow.reconciliationDifference)} positive={false} /> : null}
        <div className={styles.cashArrow}>↓</div>
        <div className={styles.cashBalance}><span>{fundsMode === "live" ? copy.balance : copy.monthEndBalance}</span><strong>{compactMoney(report.cashFlow.closingBalance)}</strong></div>
      </div>
    </section>
  </>;
}

function signedTrend(change: DashboardReportData["kpis"]["cashDifferenceChange"], copy: DashboardText) {
  return {
    change: change.percent,
    trendLabel: change.transition === "deficit_to_surplus" ? copy.deficitToSurplus : change.transition === "surplus_to_deficit" ? copy.surplusToDeficit : undefined,
    trendDirection: change.transition === "deficit_to_surplus" ? "up" as const : change.transition === "surplus_to_deficit" ? "down" as const : undefined,
  };
}

function OperatingProfitSheet({ copy, report, operatingResult, returnFocusRef, onClose }: {
  copy: DashboardText;
  report: DashboardReportData;
  operatingResult: ProvisionalOperatingProfit;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const provisional = operatingResult.mode === "provisional";
  // Read-only summary → centered compact modal; input/work sheets keep kind="bottom".
  return <BarSheet kind="full" compact title={`📊 ${provisional ? copy.provisionalDetailTitle : copy.operatingProfitDetailTitle}`} closeLabel={copy.close} onClose={onClose} returnFocusRef={returnFocusRef}
    footer={<button type="button" className={styles.sheetCloseButton} onClick={onClose}>{copy.close}</button>}>
    {provisional ? <div>
      <p className={styles.sectionNote}>{copy.provisionalNote}</p>
      <div className={styles.comparisonList}>
        <ReportValue label={copy.operatingIncome} amount={operatingResult.recognizedRevenue} />
        <ReportValue label={copy.ledgerExpense} amount={operatingResult.recognizedExpense} expense />
        <ReportValue expense label={`+ ${copy.unrecognizedPayroll}`} amount={operatingResult.warnings.includes("PAYROLL_UNAVAILABLE") ? null : operatingResult.payrollAdjustment} fallback={copy.needsCheck} />
        <ReportValue expense label={`+ ${copy.cardFeeEstimate}`} amount={operatingResult.cardFeeRateSource === "unavailable" || operatingResult.warnings.includes("CARD_SETTLEMENTS_UNAVAILABLE") || operatingResult.warnings.includes("PREVIOUS_CARD_SETTLEMENTS_UNAVAILABLE") ? null : operatingResult.estimatedCardFee} fallback={operatingResult.cardFeeRateSource === "unavailable" ? copy.estimateUnavailable : copy.needsCheck} />
        <ReportValue label={copy.provisionalExpense} amount={operatingResult.provisionalExpense} fallback={copy.needsCheck} total expense />
        <ReportValue label={copy.provisionalOperatingProfit} amount={operatingResult.operatingProfit} fallback={copy.needsCheck} emphasis />
      </div>
    </div> : <div>
      <p className={styles.sectionNote}>{copy.profitAndLossNote}</p>
      <div className={styles.comparisonList}>
        <ReportValue label={copy.operatingIncome} amount={report.profitAndLoss.income} />
        <ReportValue label={copy.operatingExpense} amount={report.profitAndLoss.expense} expense />
        <ReportValue label={copy.operatingProfit} amount={report.profitAndLoss.operatingProfit} total emphasis />
      </div>
    </div>}
  </BarSheet>;
}

function KpiCard({ icon, label, amount, change, note, trendLabel, trendDirection, action, amountClass = "" }: { icon: string; label: string; amount: number | null; change?: number | null; note?: string; trendLabel?: string; trendDirection?: "up" | "down"; action?: ReactNode; amountClass?: string }) {
  const unchanged = change === 0;
  const trend = change == null || unchanged ? "-" : `${change > 0 ? "▲" : "▼"} ${Math.abs(change).toFixed(1)}%`;
  const trendClass = trendDirection ? (trendDirection === "up" ? styles.trendUp : styles.trendDown) : change == null || unchanged ? "" : change > 0 ? styles.trendUp : styles.trendDown;
  return <article className={styles.kpiCard}><span className={styles.kpiLabel}><span className={styles.titleEmoji} aria-hidden="true">{icon}</span>{label}</span><strong className={`${styles.kpiAmount} ${amountClass}`}>{amount === null ? "-" : money(amount)}</strong><span className={styles.kpiMetaRow}><span className={`${styles.kpiMeta} ${trendClass}`}>{note ?? trendLabel ?? trend}</span>{action}</span></article>;
}

// `expense` colors only the amount of cost rows red; labels stay neutral.
function ReportValue({ label, amount, expense = false, fallback = "-", total = false, emphasis = false }: { label: string; amount: number | null; expense?: boolean; fallback?: string; total?: boolean; emphasis?: boolean }) {
  return <div className={`${styles.comparisonRow} ${styles.reportValueRow} ${total ? styles.reportTotalRow : ""} ${emphasis ? styles.reportEmphasisRow : ""}`}><span className={styles.comparisonName}>{label}</span><strong className={`${styles.comparisonAmount} ${amount === null ? styles.reportPending : expense ? styles.expenseAmount : ""}`}>{amount === null ? fallback : money(amount)}</strong></div>;
}

function BreakdownCard({ icon, title, total, rows, lang, empty, newLabel }: { icon: string; title: string; total: number; rows: DashboardReportData["income"]; lang: "ko" | "vi"; empty: string; newLabel: string }) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(() => new Set());
  return <section className={styles.reportCard}>
    <div className={styles.sectionHeader}><h2 className={styles.sectionTitle}><span className={styles.titleEmoji} aria-hidden="true">{icon}</span>{title}</h2><strong className={styles.sectionTotal}>{money(total)}</strong></div>
    {rows.length ? <div className={styles.breakdownList}>{rows.map((row) => <IncomeRow key={row.id} row={row} total={total} lang={lang} newLabel={newLabel} expanded={expandedRows.has(row.id)} onToggle={() => setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    })} />)}</div> : <p className={styles.empty}>{empty}</p>}
  </section>;
}

function IncomeRow({ row, total, lang, newLabel, expanded, onToggle }: { row: DashboardReportData["income"][number]; total: number; lang: "ko" | "vi"; newLabel: string; expanded: boolean; onToggle: () => void }) {
  return <CategoryRow name={categoryLabel(row.name, lang)} change={<MonthChange change={row.change} increaseIsGood newLabel={newLabel} />} amount={row.amount} total={total} barClass={styles.barFillIncome} details={row.details} detailName={(name) => name} expandable={row.details.length > 0} expanded={expanded} onToggle={onToggle} />;
}

function ExpenseRow({ row, total, lang, newLabel, expanded, onToggle }: { row: DashboardReportData["expenses"][number]; total: number; lang: "ko" | "vi"; newLabel: string; expanded: boolean; onToggle: () => void }) {
  return <CategoryRow name={categoryLabel(row.name, lang)} change={<MonthChange change={row.change} increaseIsGood={false} newLabel={newLabel} />} amount={row.amount} total={total} barClass={styles.barFillExpense} details={row.details} detailName={(name) => categoryLabel(name, lang)} expandable expanded={expanded} onToggle={onToggle} />;
}

// Shared income/expense category row: same chevron, column, spacing and click area.
// A row without details keeps the chevron column empty so labels stay aligned.
// Compact previous-month change shown beside a main category name (not on details).
// Income: increase is green. Expense: increase is red (cost view).
function MonthChange({ change, increaseIsGood, newLabel }: { change: BreakdownChange; increaseIsGood: boolean; newLabel: string }) {
  const increased = change.kind === "new" || (change.kind === "percent" && change.percent > 0);
  const tone = change.kind === "none" ? "" : increased === increaseIsGood ? styles.trendUp : styles.trendDown;
  const text = change.kind === "new" ? newLabel : change.kind === "percent" ? `${change.percent > 0 ? "▲" : "▼"} ${Math.abs(change.percent).toFixed(1)}%` : "-";
  return <span className={`${styles.rowChange} ${tone}`}>{text}</span>;
}

function CategoryRow({ name, change, amount, total, barClass, details, detailName, expandable, expanded, onToggle }: { name: string; change: ReactNode; amount: number; total: number; barClass: string; details: DashboardReportData["income"][number]["details"]; detailName: (name: string) => string; expandable: boolean; expanded: boolean; onToggle: () => void }) {
  const content = <>
    <span className={styles.breakdownHeader}><span className={styles.chevron} aria-hidden="true">{expandable ? expanded ? "▼" : "▶" : ""}</span><span className={styles.breakdownLabel}><span className={styles.breakdownName}>{name}</span>{change}</span><strong className={styles.breakdownAmount}>{money(amount)}</strong><span className={styles.breakdownPercent}>{share(amount, total).toFixed(1)}%</span></span>
    <span className={styles.barTrack}><span className={barClass} style={{ width: `${Math.min(100, Math.max(0, Math.abs(share(amount, total))))}%` }} /></span>
  </>;
  return <div className={styles.breakdownItem}>
    {expandable ? <button type="button" className={styles.expenseToggle} aria-expanded={expanded} onClick={onToggle}>{content}</button> : <div className={styles.staticToggle}>{content}</div>}
    {expanded && details.length ? <div className={styles.detailList}>{details.map((detail) => <div className={styles.detailRow} key={detail.id}><span>{detailName(detail.name)}</span><strong>{money(detail.amount)}</strong></div>)}</div> : null}
  </div>;
}

function CashLine({ sign, label, amount, positive = false }: { sign: string; label: string; amount: number; positive?: boolean }) {
  return <div className={`${styles.cashLine} ${positive ? styles.cashPositive : styles.cashNegative}`}><span>{sign} {label}</span><strong>{compactMoney(amount)}</strong></div>;
}

export default function LedgerDashboardPage() {
  return <Suspense fallback={<Container noPaddingTop><div className={styles.skeleton} /></Container>}><LedgerDashboardContent /></Suspense>;
}
