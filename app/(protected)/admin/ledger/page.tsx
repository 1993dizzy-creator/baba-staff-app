"use client";

import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import DashboardDetailRow from "@/components/ledger/DashboardDetailRow";
import { buildDashboardDetailEmoji } from "@/lib/ledger/dashboard-detail-emoji";
import SalesReceiptDetails from "@/components/ledger/SalesReceiptDetails";
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
  type ProvisionalOperatingProfit,
} from "@/lib/ledger/provisional-operating-profit";
import type { LedgerPayrollCost } from "@/lib/ledger/payroll-cost";
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
    cardFeePendingNote: "카드수수료 미확정 · 익월 카드입금 처리 중 자동 확정됩니다.",
    ledgerExpense: "현재 장부비용",
    unrecognizedPayroll: "미반영 급여비용",
    payrollCost: "급여/인건비",
    payrollPredicted: "예상",
    payrollFinalized: "확정",
    checking: "확인 중",
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
    cashFlowMatched: "잔액 대조 차이",
    cashExpense: "실제 현금지출",
    empty: "표시할 내역이 없습니다.",
    newItem: "신규",
    accrualCheck: "발생 기준 점검",
    accrualCheckNote: "영업이익의 비용을 귀속 월 기준으로 나누고, 기술적 보정·상쇄와 마감 이후 변경을 따로 보여줍니다.",
    closeComparison: "마감 스냅샷 대조",
    closedProfit: (revision: number | null) => revision ? `${revision}차 마감 영업이익` : "마감 영업이익",
    ledgerChangeAfterClose: "마감 후 원장 변경",
    revenueDelta: "매출 변경",
    expenseDelta: "비용 변경",
    cardAttribution: "마감 손익비용과의 카드 귀속 차이",
    otherIncomeOutsideClose: "기타 수입 (마감 영업이익 제외)",
    currentOperatingProfit: "현재 원장 기준 영업이익",
    driftNote: "마감 이후 원장이 변경되었습니다. 재마감 전까지 마감 금액과 현재 금액이 다릅니다.",
    noDriftNote: "마감 이후 원장 변경이 없습니다.",
    accrualExpense: "영업비용 구성 (발생 기준)",
    accrualExpenseNote: "실제 지급일이 아닌 귀속 월 기준입니다. 기술적 보정·상쇄는 일반 비용 분류와 분리해 표시합니다.",
    preCorrectionExpense: "보정 전 원장 비용",
    postCorrectionExpense: "보정 후 원장 비용",
    closeBasisExpense: "마감 기준 손익비용 (현재 원장)",
    technicalCorrections: "기술적 보정·상쇄",
    technicalNote: "2026년 8월 시트 합계보정(#1055)과 그 금액을 상세 거래로 옮기며 만든 상쇄입니다. 실제 운영비가 아니며, 상세 거래와 합쳐 시트 총액에 맞춥니다. 음수는 상세 거래로 이미 옮겨진 금액입니다.",
    revenueAdjustments: "매출 정정 내역",
    revenueAdjustmentsNote: "정정이 기록된 날짜와 실제 귀속 날짜를 함께 표시합니다.",
    recordedOn: "기록일",
    otherDate: "날짜 미지정",
    nonExpense: "비용이 아닌 자금 이동",
    nonExpenseNote: "임대료 선납은 지급 시 비용이 아니며, 월 임대료는 매월 발생 비용으로만 반영됩니다. 준비금 적립·해제는 보유금 안의 구분이며 영업비용이 아닙니다.",
    prepaidPayments: "선급비용 지급 (임대료 선납 등)",
    reserveAllocated: "준비금 적립",
    reserveReleased: "준비금 해제·사용",
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
    cardFeePendingNote: "Phí thẻ chưa chốt · Tự động xác nhận khi xử lý tiền về tháng sau.",
    ledgerExpense: "Chi phí đã ghi sổ",
    unrecognizedPayroll: "Chi phí lương chưa ghi sổ",
    payrollCost: "Chi phí lương",
    payrollPredicted: "Dự kiến",
    payrollFinalized: "Đã chốt",
    checking: "Đang kiểm tra",
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
    cashFlowMatched: "Chênh lệch đối chiếu số dư",
    cashExpense: "Tiền thực chi",
    empty: "Không có dữ liệu để hiển thị.",
    newItem: "Mới",
    accrualCheck: "Kiểm tra theo phát sinh",
    accrualCheckNote: "Chia chi phí của lợi nhuận theo tháng ghi nhận, tách riêng điều chỉnh kỹ thuật·bù trừ và thay đổi sau khi chốt sổ.",
    closeComparison: "Đối chiếu bản chốt sổ",
    closedProfit: (revision: number | null) => revision ? `Lợi nhuận bản chốt lần ${revision}` : "Lợi nhuận bản chốt",
    ledgerChangeAfterClose: "Thay đổi sổ sau khi chốt",
    revenueDelta: "Thay đổi doanh thu",
    expenseDelta: "Thay đổi chi phí",
    cardAttribution: "Chênh lệch phân bổ thẻ so với chi phí chốt sổ",
    otherIncomeOutsideClose: "Thu nhập khác (ngoài lợi nhuận chốt sổ)",
    currentOperatingProfit: "Lợi nhuận theo sổ hiện tại",
    driftNote: "Sổ đã thay đổi sau khi chốt. Số chốt và số hiện tại khác nhau cho đến khi chốt lại.",
    noDriftNote: "Không có thay đổi sổ sau khi chốt.",
    accrualExpense: "Cơ cấu chi phí kinh doanh (theo phát sinh)",
    accrualExpenseNote: "Theo tháng ghi nhận, không theo ngày chi thực tế. Điều chỉnh kỹ thuật·bù trừ được tách khỏi các phân loại chi phí thông thường.",
    preCorrectionExpense: "Chi phí sổ trước điều chỉnh",
    postCorrectionExpense: "Chi phí sổ sau điều chỉnh",
    closeBasisExpense: "Chi phí theo chuẩn chốt sổ (sổ hiện tại)",
    technicalCorrections: "Điều chỉnh kỹ thuật·bù trừ",
    technicalNote: "Điều chỉnh tổng theo bảng tính tháng 8/2026 (#1055) và các bút toán bù trừ khi chuyển số tiền đó sang giao dịch chi tiết. Không phải chi phí vận hành thực tế; cộng với giao dịch chi tiết để khớp tổng bảng tính. Số âm là phần đã chuyển sang giao dịch chi tiết.",
    revenueAdjustments: "Điều chỉnh doanh thu",
    revenueAdjustmentsNote: "Hiển thị cả ngày ghi điều chỉnh và ngày phát sinh thực tế.",
    recordedOn: "Ngày ghi",
    otherDate: "Không rõ ngày",
    nonExpense: "Dòng tiền không phải chi phí",
    nonExpenseNote: "Tiền thuê trả trước không phải chi phí khi trả; tiền thuê hằng tháng chỉ ghi nhận là chi phí phát sinh mỗi tháng. Trích lập·giải phóng quỹ dự phòng chỉ phân loại trong tiền hiện có, không phải chi phí kinh doanh.",
    prepaidPayments: "Chi trả trước (tiền thuê trả trước, v.v.)",
    reserveAllocated: "Trích lập quỹ dự phòng",
    reserveReleased: "Giải phóng·sử dụng quỹ dự phòng",
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
  "급여/인건비": "Lương/nhân sự",
  "보험·복리후생": "Bảo hiểm·phúc lợi",
  "보험": "Bảo hiểm",
  "복리후생": "Phúc lợi",
  "직원 식대": "Tiền ăn nhân viên",
  "직원 주거비": "Nhà ở nhân viên",
  "임대료": "Tiền thuê mặt bằng",
  "기타 비용": "Chi phí khác",
};

type ProvisionalSources = {
  // Month payroll cost (any month); null while the request is in flight.
  payroll: LedgerPayrollCost | null;
  payrollLoading: boolean;
  cardsLoading: boolean;
  // Card sources: current month only (null otherwise).
  cards: { currentCard: CardSettlementSource | null; previousCard: CardSettlementSource | null } | null;
};
type DashboardState = {
  month: string;
  current: DashboardLedgerData;
  previous: DashboardLedgerData;
  provisional: ProvisionalSources;
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

function loadCardSources(month: string, previousMonth: string, signal: AbortSignal) {
  return Promise.all([
    loadOptionalMonthBody(`/api/admin/ledger/card-settlements?month=${month}`, month, signal, (body) => (body.summary ?? null) as CardSettlementSource | null),
    loadOptionalMonthBody(`/api/admin/ledger/card-settlements?month=${previousMonth}`, previousMonth, signal, (body) => (body.summary ?? null) as CardSettlementSource | null),
  ]).then(([currentCard, previousCard]) => ({ currentCard, previousCard }));
}

// Month payroll cost (finalized / predicted). A failed request is "unavailable",
// never a silent 0.
async function loadPayrollCost(month: string, signal: AbortSignal): Promise<LedgerPayrollCost> {
  const payroll = await loadOptionalMonthBody(`/api/admin/ledger/payroll-cost?month=${month}`, month, signal, (body) => body as unknown as LedgerPayrollCost);
  return payroll ?? { month, status: "unavailable", amount: null, recognizedAmount: 0, adjustment: null, batchStatus: null, reason: "PAYROLL_ESTIMATE_FAILED" };
}
type DashboardReportData = ReturnType<typeof buildDashboardReport>;
type DashboardText = (typeof text)["ko"] | (typeof text)["vi"];

const money = (amount: number) =>
  `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(amount))} ₫`;

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
        // Payroll cost loads for every month (predicted until the batch completes) and
        // never blocks the report; card estimates are current-month only.
        const payrollPromise = loadPayrollCost(month, controller.signal);
        const cardPromise = isCurrentMonth ? loadCardSources(month, previousMonth, controller.signal) : Promise.resolve(null);
        const [currentResponse, previousResponse] = await Promise.all([
          fetch(`/api/admin/ledger?month=${month}&scope=dashboard`, { cache: "no-store", signal: controller.signal }),
          fetch(`/api/admin/ledger?month=${previousMonth}&scope=dashboard`, { cache: "no-store", signal: controller.signal }),
        ]);
        const [currentBody, previousBody] = await Promise.all([
          currentResponse.json(),
          previousResponse.json(),
        ]);
        if (!currentResponse.ok || !previousResponse.ok) {
          throw new Error("DASHBOARD_LOAD_FAILED");
        }
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
          provisional: { payroll: null, payrollLoading: true, cards: null, cardsLoading: isCurrentMonth },
        });
        // Optional estimates update independently; neither gates the core report or the other.
        void cardPromise.then(cards => {
          if (controller.signal.aborted || requestSequence !== requestSequenceRef.current) return;
          setDashboardState(state => state && state.month === month
            ? { ...state, provisional: { ...state.provisional, cards, cardsLoading: false } }
            : state);
        });
        void payrollPromise.then(payroll => {
          if (controller.signal.aborted || requestSequence !== requestSequenceRef.current || payroll.month !== month) return;
          setDashboardState(state => state && state.month === month
            ? { ...state, provisional: { ...state.provisional, payroll, payrollLoading: false } }
            : state);
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
        isCurrentMonth: isCurrentMonth && dashboardState.current.fundsView.mode === "live",
        summary: dashboardState.current.summary,
        payroll: dashboardState.provisional.payroll,
        payrollLoading: dashboardState.provisional.payrollLoading,
        currentCard: dashboardState.provisional.cards?.currentCard ?? null,
        previousCard: dashboardState.provisional.cards?.previousCard ?? null,
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
      key={month}
      copy={copy}
      lang={lang}
      fundsMode={dashboardState.current.fundsView.mode}
      report={report}
      month={month}
      detailEmoji={buildDashboardDetailEmoji(dashboardState.current)}
      salesReceiptExplanation={dashboardState.current.salesReceiptExplanation}
      operatingResult={operatingResult}
      accrual={dashboardState.current.accrual}
      cardsLoading={isCurrentMonth && dashboardState.current.fundsView.mode === "live" && dashboardState.provisional.cardsLoading}
      expandedExpenses={expandedExpenses}
      onToggleExpense={(id) => setExpandedExpenses((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      })}
    /> : null}
  </main></Container>;
}

function DashboardReport({ detailEmoji, copy, lang, fundsMode, report, month, salesReceiptExplanation, operatingResult, accrual, cardsLoading, expandedExpenses, onToggleExpense }: {
  detailEmoji: ReturnType<typeof buildDashboardDetailEmoji>;
  copy: DashboardText;
  lang: "ko" | "vi";
  fundsMode: DashboardLedgerData["fundsView"]["mode"];
  report: DashboardReportData;
  month: string;
  salesReceiptExplanation: DashboardLedgerData["salesReceiptExplanation"];
  operatingResult: ProvisionalOperatingProfit;
  accrual: DashboardLedgerData["accrual"];
  cardsLoading: boolean;
  expandedExpenses: Set<number>;
  onToggleExpense: (id: number) => void;
}) {
  const [operatingDetailOpen, setOperatingDetailOpen] = useState(false);
  const detailButtonRef = useRef<HTMLButtonElement>(null);
  const detailButton = <button ref={detailButtonRef} type="button" className={styles.kpiDetailButton} aria-haspopup="dialog" onClick={() => setOperatingDetailOpen(true)}>{copy.detail} ›</button>;
  return <>
    <section className={styles.kpiGrid} aria-label="KPI">
      <KpiCard icon="📈" label={copy.cashDifference} amount={report.kpis.cashDifference} {...signedTrend(report.kpis.cashDifferenceChange, copy)} />
      {operatingResult.mode === "provisional"
        // Provisional vs. final profit are different bases, so no month-over-month %.
        ? <KpiCard icon="📊" label={copy.provisionalOperatingProfit} amount={operatingResult.operatingProfit} note={cardsLoading || operatingResult.warnings.includes("PAYROLL_LOADING") ? copy.checking : operatingResult.needsCheck ? copy.needsCheck : copy.provisional} trendDirection={operatingResult.needsCheck ? "down" : undefined} action={detailButton} />
        : <KpiCard icon="📊" label={copy.operatingProfit} amount={report.kpis.operatingProfit} {...signedTrend(report.kpis.operatingProfitChange, copy)} action={detailButton} />}
    </section>

    {operatingDetailOpen ? <OperatingProfitSheet copy={copy} report={report} operatingResult={operatingResult} cardsLoading={cardsLoading} returnFocusRef={detailButtonRef} onClose={() => setOperatingDetailOpen(false)} /> : null}

    <BreakdownCard icon="📊" title={copy.incomeComposition} total={report.kpis.income} rows={report.income} detailEmoji={detailEmoji} lang={lang} empty={copy.empty} newLabel={copy.newItem} change={report.kpis.incomeChange} month={month} salesReceiptExplanation={salesReceiptExplanation} />

    <section className={styles.reportCard}>
      <div className={styles.sectionHeader}><h2 className={styles.sectionTitle}><span className={styles.titleEmoji} aria-hidden="true">📉</span>{copy.expenseComposition}<CompositionChange change={report.kpis.expenseChange} /></h2><strong className={styles.sectionTotal}>{money(report.kpis.expense)}</strong></div>
      {report.expenses.length ? <div className={styles.breakdownList}>{report.expenses.map((row) => <ExpenseRow detailEmoji={detailEmoji} key={row.id} row={row} total={report.kpis.expense} lang={lang} newLabel={copy.newItem} expanded={expandedExpenses.has(row.id)} onToggle={() => onToggleExpense(row.id)} />)}</div> : <p className={styles.empty}>{copy.empty}</p>}
    </section>

    <section className={styles.reportCard}>
      <div className={styles.sectionHeader}><h2 className={styles.sectionTitle}><span className={styles.titleEmoji} aria-hidden="true">💵</span>{copy.cashFlow}</h2></div>
      <div className={styles.cashFlow}>
        <div className={styles.cashBalance}><span>{copy.openingBalance}</span><strong>{money(report.cashFlow.openingBalance)}</strong></div>
        <div className={styles.cashArrow}>↓</div>
        <CashLine sign="+" label={copy.receivedIncome} amount={report.cashFlow.receivedIncome} positive />
        <CashLine sign="−" label={copy.cashExpense} amount={report.cashFlow.actualCashOutflow} />
        <CashLine sign={report.cashFlow.investmentCashFlow < 0 ? "−" : "+"} label={copy.investment} amount={Math.abs(report.cashFlow.investmentCashFlow)} positive={report.cashFlow.investmentCashFlow >= 0} />
        <CashLine sign={report.cashFlow.otherFundAdjustment < 0 ? "−" : "+"} label={copy.otherAdjustment} amount={Math.abs(report.cashFlow.otherFundAdjustment)} positive={report.cashFlow.otherFundAdjustment >= 0} />
        {Math.abs(report.cashFlow.reconciliationDifference) >= 0.5 ? <CashLine sign={report.cashFlow.reconciliationDifference < 0 ? "−" : "+"} label={copy.reconciliationWarning} amount={Math.abs(report.cashFlow.reconciliationDifference)} positive={false} /> : <CashLine sign="" label={copy.cashFlowMatched} amount={0} positive />}
        <div className={styles.cashArrow}>↓</div>
        <div className={styles.cashBalance}><span>{fundsMode === "live" ? copy.balance : copy.monthEndBalance}</span><strong>{money(report.cashFlow.closingBalance)}</strong></div>
      </div>
    </section>

    {accrual ? <AccrualCheckCard copy={copy} lang={lang} accrual={accrual} /> : null}
  </>;
}

function signedTrend(change: DashboardReportData["kpis"]["cashDifferenceChange"], copy: DashboardText) {
  return {
    change: change.percent,
    trendLabel: change.transition === "deficit_to_surplus" ? copy.deficitToSurplus : change.transition === "surplus_to_deficit" ? copy.surplusToDeficit : undefined,
    trendDirection: change.transition === "deficit_to_surplus" ? "up" as const : change.transition === "surplus_to_deficit" ? "down" as const : undefined,
  };
}

function OperatingProfitSheet({ copy, report, operatingResult, cardsLoading, returnFocusRef, onClose }: {
  copy: DashboardText;
  report: DashboardReportData;
  operatingResult: ProvisionalOperatingProfit;
  cardsLoading: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const provisional = operatingResult.mode === "provisional";
  // Read-only summary → centered compact modal; input/work sheets keep kind="bottom".
  return <BarSheet kind="full" compact title={`📊 ${provisional ? copy.provisionalDetailTitle : copy.operatingProfitDetailTitle}`} closeLabel={copy.close} onClose={onClose} returnFocusRef={returnFocusRef}
    footer={<button type="button" className={styles.sheetCloseButton} onClick={onClose}>{copy.close}</button>}>
    {provisional ? <div>
      <p className={styles.sectionNote}>{operatingResult.warnings.includes("CARD_FEE_PENDING") ? copy.cardFeePendingNote : copy.provisionalNote}</p>
      <div className={styles.comparisonList}>
        <ReportValue label={copy.operatingIncome} amount={operatingResult.recognizedRevenue} />
        <ReportValue label={copy.ledgerExpense} amount={operatingResult.recognizedExpense} expense />
        {!operatingResult.warnings.includes("CARD_FEE_PENDING") && <><ReportValue expense label={`+ ${payrollLabel(operatingResult, copy)}`} amount={operatingResult.warnings.includes("PAYROLL_UNAVAILABLE") || operatingResult.warnings.includes("PAYROLL_LOADING") ? null : operatingResult.payrollAdjustment} fallback={operatingResult.warnings.includes("PAYROLL_LOADING") ? copy.checking : copy.estimateUnavailable} />
        <ReportValue expense label={`+ ${copy.cardFeeEstimate}`} amount={cardsLoading || operatingResult.cardFeeRateSource === "unavailable" || operatingResult.warnings.includes("CARD_SETTLEMENTS_UNAVAILABLE") || operatingResult.warnings.includes("PREVIOUS_CARD_SETTLEMENTS_UNAVAILABLE") ? null : operatingResult.estimatedCardFee} fallback={cardsLoading ? copy.checking : operatingResult.cardFeeRateSource === "unavailable" ? copy.estimateUnavailable : copy.needsCheck} /></>}
        <ReportValue label={copy.provisionalExpense} amount={operatingResult.provisionalExpense} fallback={cardsLoading || operatingResult.warnings.includes("PAYROLL_LOADING") ? copy.checking : copy.needsCheck} total expense />
        <ReportValue label={copy.provisionalOperatingProfit} amount={operatingResult.operatingProfit} fallback={cardsLoading || operatingResult.warnings.includes("PAYROLL_LOADING") ? copy.checking : copy.needsCheck} emphasis />
      </div>
    </div> : <div>
      <p className={styles.sectionNote}>{copy.profitAndLossNote}</p>
      <div className={styles.comparisonList}>
        <ReportValue label={copy.operatingIncome} amount={report.profitAndLoss.income} />
        <ReportValue label={copy.operatingExpense} amount={report.profitAndLoss.expense} expense />
        <ReportValue label={copy.operatingProfit} amount={report.profitAndLoss.operatingProfit} total emphasis />
      </div>
      {operatingResult.payroll?.status === "finalized" && operatingResult.payroll.amount !== null
        ? <p className={styles.sectionNote}>{copy.payrollCost} {money(operatingResult.payroll.amount)} · <span className={styles.payrollBadge}>{copy.payrollFinalized}</span></p>
        : null}
    </div>}
  </BarSheet>;
}

// "급여/인건비 · 예상|확정" — the payroll row label in the provisional detail.
function payrollLabel(operatingResult: ProvisionalOperatingProfit, copy: DashboardText) {
  const status = operatingResult.payroll?.status;
  if (status === "predicted") return `${copy.payrollCost} · ${copy.payrollPredicted}`;
  if (status === "finalized") return `${copy.payrollCost} · ${copy.payrollFinalized}`;
  return status === "loading" || status === "unavailable" ? `${copy.payrollCost} · ${copy.payrollPredicted}` : copy.unrecognizedPayroll;
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

function CompositionChange({ change }: { change: number | null }) {
  if (change == null) return null;
  return <span className={`${styles.compositionChange} ${change > 0 ? styles.trendUp : change < 0 ? styles.trendDown : ""}`}>{change === 0 ? "0.0%" : `${change > 0 ? "↑" : "↓"} ${Math.abs(change).toFixed(1)}%`}</span>;
}

function BreakdownCard({ detailEmoji, icon, title, total, rows, lang, empty, newLabel, change, month, salesReceiptExplanation }: { icon: string; title: string; total: number; detailEmoji: ReturnType<typeof buildDashboardDetailEmoji>; rows: DashboardReportData["income"]; lang: "ko" | "vi"; empty: string; newLabel: string; change: number | null; month: string; salesReceiptExplanation: DashboardLedgerData["salesReceiptExplanation"] }) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(() => new Set());
  return <section className={styles.reportCard}>
    <div className={styles.sectionHeader}><h2 className={styles.sectionTitle}><span className={styles.titleEmoji} aria-hidden="true">{icon}</span>{title}<CompositionChange change={change} /></h2><strong className={styles.sectionTotal}>{money(total)}</strong></div>
    {rows.length ? <div className={styles.breakdownList}>{rows.map((row) => <IncomeRow detailEmoji={detailEmoji} key={row.id} month={month} salesReceiptExplanation={salesReceiptExplanation} row={row} total={total} lang={lang} newLabel={newLabel} expanded={expandedRows.has(row.id)} onToggle={() => setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    })} />)}</div> : <p className={styles.empty}>{empty}</p>}
  </section>;
}

function IncomeRow({ detailEmoji, row, total, lang, newLabel, expanded, onToggle, month, salesReceiptExplanation }: { detailEmoji: ReturnType<typeof buildDashboardDetailEmoji>; row: DashboardReportData["income"][number]; total: number; lang: "ko" | "vi"; newLabel: string; expanded: boolean; onToggle: () => void; month: string; salesReceiptExplanation: DashboardLedgerData["salesReceiptExplanation"] }) {
  return <CategoryRow name={categoryLabel(row.name, lang)} change={<MonthChange change={row.change} increaseIsGood newLabel={newLabel} />} amount={row.amount} total={total} barClass={styles.barFillIncome} details={row.details} detailEmoji={(detail) => detailEmoji(detail, "income", row.id)} detailName={(name) => name} expandedContent={row.id === -1 ? <SalesReceiptDetails month={month} data={salesReceiptExplanation} lang={lang} /> : undefined} expandable={row.id === -1 || row.details.length > 0} expanded={expanded} onToggle={onToggle} />;
}

function ExpenseRow({ detailEmoji, row, total, lang, newLabel, expanded, onToggle }: { detailEmoji: ReturnType<typeof buildDashboardDetailEmoji>; row: DashboardReportData["expenses"][number]; total: number; lang: "ko" | "vi"; newLabel: string; expanded: boolean; onToggle: () => void }) {
  return <CategoryRow name={categoryLabel(row.name, lang)} change={<MonthChange change={row.change} increaseIsGood={false} newLabel={newLabel} />} amount={row.amount} total={total} barClass={styles.barFillExpense} details={row.details} detailEmoji={(detail) => detailEmoji(detail, "expense", row.id)} detailName={(name) => categoryLabel(name, lang)} expandable expanded={expanded} onToggle={onToggle} />;
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

function CategoryRow({ name, change, amount, total, barClass, details, detailEmoji, detailName, expandable, expanded, onToggle, expandedContent }: { name: string; change: ReactNode; amount: number; total: number; barClass: string; details: DashboardReportData["income"][number]["details"]; detailEmoji: (detail: DashboardReportData["income"][number]["details"][number]) => string; detailName: (name: string) => string; expandable: boolean; expanded: boolean; onToggle: () => void; expandedContent?: ReactNode }) {
  const content = <>
    <span className={styles.breakdownHeader}><span className={styles.chevron} aria-hidden="true">{expandable ? expanded ? "▼" : "▶" : ""}</span><span className={styles.breakdownLabel}><span className={styles.breakdownName}>{name}</span>{change}</span><strong className={styles.breakdownAmount}>{money(amount)}</strong><span className={styles.breakdownPercent}>{share(amount, total).toFixed(1)}%</span></span>
    <span className={styles.barTrack}><span className={barClass} style={{ width: `${Math.min(100, Math.max(0, Math.abs(share(amount, total))))}%` }} /></span>
  </>;
  return <div className={styles.breakdownItem}>
    {expandable ? <button type="button" className={styles.expenseToggle} aria-expanded={expanded} onClick={onToggle}>{content}</button> : <div className={styles.staticToggle}>{content}</div>}
    {expanded && expandedContent ? <div className={styles.detailList}>{expandedContent}</div> : expanded && details.length ? <div className={styles.detailList}>{details.map((detail) => <DashboardDetailRow key={detail.id} emoji={detailEmoji(detail)} name={detailName(detail.name)} amount={money(detail.amount)} />)}</div> : null}
  </div>;
}

function CashLine({ sign, label, amount, positive = false }: { sign: string; label: string; amount: number; positive?: boolean }) {
  return <div className={`${styles.cashLine} ${positive ? styles.cashPositive : styles.cashNegative}`}><span>{sign} {label}</span><strong>{money(amount)}</strong></div>;
}

const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
// Ledger amounts keep up to 3 decimals (e.g. 551.657.006,5 ₫), so the accrual view
// shows them exactly instead of rounding like the cash report.
const exactMoney = (amount: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(amount)} ₫`;
const signedMoney = (amount: number) => `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${exactMoney(Math.abs(amount))}`;

// Accrual check card under the cash flow: a compact summary plus its own read-only
// sheet. The KPI operating-profit sheet keeps its fixed rows.
function AccrualCheckCard({ copy, lang, accrual }: { copy: DashboardText; lang: "ko" | "vi"; accrual: NonNullable<DashboardLedgerData["accrual"]> }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return <section className={styles.reportCard} aria-label={copy.accrualCheck}>
    <div className={styles.sectionHeader}>
      <h2 className={styles.sectionTitle}><span className={styles.titleEmoji} aria-hidden="true">🧾</span>{copy.accrualCheck}</h2>
      <button ref={buttonRef} type="button" className={styles.kpiDetailButton} aria-haspopup="dialog" onClick={() => setOpen(true)}>{copy.detail} ›</button>
    </div>
    <p className={styles.accrualNote}>{copy.accrualCheckNote}</p>
    {accrual.technical.items.length ? <>
      <AccrualLine label={copy.preCorrectionExpense} value={exactMoney(accrual.operatingExpense)} />
      <AccrualLine label={copy.technicalCorrections} value={signedMoney(accrual.technical.total)} />
    </> : null}
    <AccrualLine label={copy.postCorrectionExpense} value={exactMoney(accrual.totalExpense)} strong />
    {accrual.close ? <AccrualLine label={copy.ledgerChangeAfterClose} value={signedMoney(accrual.close.ledgerChange)} tone={accrual.close.drift ? "warn" : undefined} /> : null}
    {open ? <BarSheet kind="full" compact title={`🧾 ${copy.accrualCheck}`} closeLabel={copy.close} onClose={() => setOpen(false)} returnFocusRef={buttonRef}
      footer={<button type="button" className={styles.sheetCloseButton} onClick={() => setOpen(false)}>{copy.close}</button>}>
      <AccrualDetails copy={copy} lang={lang} accrual={accrual} />
    </BarSheet> : null}
  </section>;
}

// Display-only accrual view (lib/ledger/accrual-report.ts): the same recognized rows
// as the dashboard totals, regrouped. Native <details> keeps long lists collapsible.
function AccrualDetails({ copy, lang, accrual }: { copy: DashboardText; lang: "ko" | "vi"; accrual: NonNullable<DashboardLedgerData["accrual"]> }) {
  const { close, technical, nonExpense } = accrual;
  return <>
    {close ? <section className={styles.accrualSection} aria-label={copy.closeComparison}>
      <h3 className={styles.accrualHeading}>{copy.closeComparison}</h3>
      <div className={styles.comparisonList}>
        <AccrualLine label={copy.closedProfit(close.revision)} value={exactMoney(close.snapshotOperatingProfit)} />
        <AccrualLine label={copy.ledgerChangeAfterClose} value={signedMoney(close.ledgerChange)} tone={close.drift ? "warn" : undefined} />
        {close.drift ? <>
          <AccrualLine sub label={copy.revenueDelta} value={signedMoney(close.revenueChange)} />
          <AccrualLine sub label={copy.expenseDelta} value={signedMoney(close.expenseChange)} />
        </> : null}
        {Math.abs(close.cardAttribution) >= 0.5 ? <AccrualLine label={copy.cardAttribution} value={signedMoney(close.cardAttribution)} /> : null}
        {Math.abs(close.otherIncome) >= 0.5 ? <AccrualLine label={copy.otherIncomeOutsideClose} value={signedMoney(close.otherIncome)} /> : null}
        <AccrualLine label={copy.currentOperatingProfit} value={exactMoney(close.dashboardOperatingProfit)} strong />
      </div>
      <p className={`${styles.accrualNote} ${close.drift ? styles.accrualWarn : ""}`}>{close.drift ? copy.driftNote : copy.noDriftNote}</p>
    </section> : null}

    <section className={styles.accrualSection} aria-label={copy.accrualExpense}>
      <h3 className={styles.accrualHeading}>{copy.accrualExpense}</h3>
      <p className={styles.accrualNote}>{copy.accrualExpenseNote}</p>
      <AccrualLine label={copy.preCorrectionExpense} value={exactMoney(accrual.operatingExpense)} strong />
      {accrual.expenses.map(row => <details key={row.id} className={styles.accrualGroup}>
        <summary className={styles.accrualSummary}><span>{categoryLabel(row.name, lang)}</span><strong className={styles.expenseAmount}>{exactMoney(row.amount)}</strong></summary>
        {row.details.map(detail => <AccrualLine key={detail.id} sub label={categoryLabel(detail.name, lang)} value={exactMoney(detail.amount)} />)}
      </details>)}
      {technical.items.length ? <details className={`${styles.accrualGroup} ${styles.accrualTechnical}`}>
        <summary className={styles.accrualSummary}><span>{copy.technicalCorrections}</span><strong>{signedMoney(technical.total)}</strong></summary>
        <p className={styles.accrualNote}>{copy.technicalNote}</p>
        {technical.items.map(item => <AccrualLine key={item.id} sub label={`#${item.id} · ${shortDate(item.date)} · ${item.name}`} value={signedMoney(item.amount)} />)}
      </details> : null}
      <AccrualLine label={copy.postCorrectionExpense} value={exactMoney(accrual.totalExpense)} strong />
      {/* Month-close expense = ledger expense + sale-month card attribution recorded at close. */}
      {close && Math.abs(close.cardAttribution) >= 0.0005 ? <>
        <AccrualLine label={copy.cardAttribution} value={signedMoney(close.cardAttribution)} />
        <AccrualLine label={copy.closeBasisExpense} value={exactMoney(accrual.totalExpense + close.cardAttribution)} />
      </> : null}
    </section>

    {accrual.revenueAdjustments.length ? <section className={styles.accrualSection} aria-label={copy.revenueAdjustments}>
      <h3 className={styles.accrualHeading}>{copy.revenueAdjustments}</h3>
      <p className={styles.accrualNote}>{copy.revenueAdjustmentsNote}</p>
      {accrual.revenueAdjustments.map(adjustment => <details key={adjustment.id} className={styles.accrualGroup}>
        <summary className={styles.accrualSummary}><span>{`#${adjustment.id} · ${adjustment.name} · ${copy.recordedOn} ${shortDate(adjustment.recordedDate)}`}</span><strong>{signedMoney(adjustment.amount)}</strong></summary>
        {adjustment.items.map((item, index) => <AccrualLine key={index} sub label={`${item.date ? shortDate(item.date) : copy.otherDate}${item.note ? ` · ${item.note}` : ""}`} value={signedMoney(item.amount)} />)}
      </details>)}
    </section> : null}

    {nonExpense.prepaidPayments || nonExpense.reserveAllocated || nonExpense.reserveReleased ? <section className={styles.accrualSection} aria-label={copy.nonExpense}>
      <h3 className={styles.accrualHeading}>{copy.nonExpense}</h3>
      {nonExpense.prepaidPayments ? <AccrualLine label={copy.prepaidPayments} value={exactMoney(nonExpense.prepaidPayments)} /> : null}
      {nonExpense.reserveAllocated ? <AccrualLine label={copy.reserveAllocated} value={exactMoney(nonExpense.reserveAllocated)} /> : null}
      {nonExpense.reserveReleased ? <AccrualLine label={copy.reserveReleased} value={exactMoney(nonExpense.reserveReleased)} /> : null}
      <p className={styles.accrualNote}>{copy.nonExpenseNote}</p>
    </section> : null}
  </>;
}

function AccrualLine({ label, value, sub = false, strong = false, tone }: { label: string; value: string; sub?: boolean; strong?: boolean; tone?: "warn" }) {
  return <div className={`${styles.accrualLine} ${sub ? styles.accrualSub : ""} ${strong ? styles.accrualStrong : ""} ${tone === "warn" ? styles.accrualWarn : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

export default function LedgerDashboardPage() {
  return <Suspense fallback={<Container noPaddingTop><div className={styles.skeleton} /></Container>}><LedgerDashboardContent /></Suspense>;
}
