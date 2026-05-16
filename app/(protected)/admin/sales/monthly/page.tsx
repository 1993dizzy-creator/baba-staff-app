"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { getBusinessDate } from "@/lib/common/business-time";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import { commonText, salesText } from "@/lib/text";

const salesTabs = [
  { href: "/admin/sales", key: "daily" },
  { href: "/admin/sales/receipts", key: "receipts" },
  { href: "/admin/sales/monthly", key: "monthly" },
] as const;

type SalesMonthlyText =
  (typeof salesText)[keyof typeof salesText]["monthly"];
type SalesCommonText = (typeof salesText)[keyof typeof salesText]["common"];
type CommonText = (typeof commonText)[keyof typeof commonText];
type SalesMonthlyViewText = SalesCommonText &
  SalesMonthlyText &
  Pick<
    CommonText,
    "noData" | "loading" | "error" | "loadFailed" | "cash" | "transfer" | "card" | "totalTax" | "vat"
  > & {
    other: CommonText["etc"];
    weekdays: CommonText["calendarWeekdays"];
  };

type PaymentSummary = {
  cashAmount: number;
  transferAmount: number;
  cardAmount: number;
  otherAmount: number;
  paymentTotalAmount: number;
};

type TaxSummary = {
  totalTaxAmount: number;
  taxSavingAmount: number;
  taxByRate: {
    taxRate: number;
    taxAmount: number;
    lineCount: number;
  }[];
};

type MonthlyDay = {
  businessDate: string;
  receiptCount: number;
  salesAmount?: number;
  totalFinalAmount: number;
  paymentTotalAmount: number;
  cashAmount: number;
  transferAmount: number;
  cardAmount: number;
  otherAmount: number;
  taxAmount: number;
  taxSavingAmount: number;
};

type SalesMonthlyResponse = {
  ok: boolean;
  month?: string;
  error?: string;
  summary?: {
    totalSales: number;
    receiptCount: number;
    totalReceiptCount: number;
    canceledReceiptCount: number;
    averageReceiptAmount: number;
  };
  paymentSummary?: PaymentSummary;
  taxSummary?: TaxSummary;
  days?: MonthlyDay[];
};

function formatVnd(value?: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatNumber(value?: number) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function getWeekdayInfo(
  dateKey: string,
  labels: CommonText["calendarWeekdays"]
) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const dayIndex = date.getDay();

  return {
    label: labels[dayIndex] || "",
    tone: dayIndex === 0 ? "sun" : dayIndex === 6 ? "sat" : "weekday",
  };
}

function getWeekdayStyle(tone: string) {
  if (tone === "sun") return sundayTextStyle;
  if (tone === "sat") return saturdayTextStyle;
  return weekdayTextStyle;
}

function getCurrentMonth() {
  return getBusinessDate().slice(0, 7);
}

function isValidBusinessDate(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function getMonthStartDate(month: string) {
  return `${month}-01`;
}

function getInitialMonth(searchParams: ReturnType<typeof useSearchParams>) {
  const queryMonth = searchParams.get("month");
  if (queryMonth) return queryMonth;

  const sharedBusinessDate = searchParams.get("businessDate");
  if (isValidBusinessDate(sharedBusinessDate)) {
    return sharedBusinessDate.slice(0, 7);
  }

  return getCurrentMonth();
}

function shiftMonth(month: string, diff: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + diff, 1));
  return date.toISOString().slice(0, 7);
}

function getDailyFinalAmount(day: MonthlyDay) {
  const paymentTotal = Number(day.paymentTotalAmount || 0);
  if (paymentTotal > 0) return paymentTotal;

  const totalFinal = Number(day.totalFinalAmount || 0);
  if (totalFinal > 0) return totalFinal;

  return Number(day.salesAmount || 0);
}

export default function SalesMonthlyPage() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { lang } = useLanguage();
  const t = salesText[lang];
  const c = commonText[lang];
  const s = t.common;
  const monthlyText = useMemo(
    () => ({
      ...s,
      ...t.monthly,
      noData: c.noData,
      loading: c.loading,
      error: c.error,
      loadFailed: c.loadFailed,
      cash: c.cash,
      transfer: c.transfer,
      card: c.card,
      other: c.etc,
      totalTax: c.totalTax,
      vat: c.vat,
      weekdays: c.calendarWeekdays,
    }),
    [c, s, t.monthly]
  );
  const initialMonth = getInitialMonth(searchParams);
  const [month, setMonth] = useState(initialMonth);
  const [monthlyData, setMonthlyData] = useState<SalesMonthlyResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const sharedBusinessDate = getMonthStartDate(month);

  const tabs = salesTabs.map((tab) => ({
    label: t.tabs[tab.key],
    href:
      tab.href === "/admin/sales/monthly"
        ? `${tab.href}?month=${encodeURIComponent(month)}&businessDate=${encodeURIComponent(sharedBusinessDate)}`
        : `${tab.href}?businessDate=${encodeURIComponent(sharedBusinessDate)}`,
    active:
      tab.href === "/admin/sales"
        ? pathname === "/admin/sales" || pathname === "/admin/sales/"
        : pathname.startsWith(tab.href),
  }));

  const fetchMonthlySales = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      setErrorMessage("");

      try {
        const res = await fetch(
          `/api/admin/sales/monthly?month=${encodeURIComponent(month)}`,
          {
            cache: "no-store",
            signal,
          }
        );
        const result = (await res.json()) as SalesMonthlyResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || monthlyText.loadFailed);
        }

        setMonthlyData(result);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setErrorMessage(
          error instanceof Error
            ? error.message
            : monthlyText.loadFailed
        );
        setMonthlyData(null);
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [month, monthlyText.loadFailed]
  );

  useEffect(() => {
    const controller = new AbortController();

    fetchMonthlySales(controller.signal);

    return () => controller.abort();
  }, [fetchMonthlySales]);

  function handleMonthChange(nextMonth: string) {
    setMonth(nextMonth);
    router.replace(
      `${pathname}?month=${encodeURIComponent(nextMonth)}&businessDate=${encodeURIComponent(getMonthStartDate(nextMonth))}`,
      {
        scroll: false,
      }
    );
  }

  const summary = monthlyData?.summary;
  const paymentSummary = monthlyData?.paymentSummary;
  const taxSummary = monthlyData?.taxSummary;
  const days = monthlyData?.days || [];
  const salesDays = days.filter(
    (day) => getDailyFinalAmount(day) > 0 || day.receiptCount > 0
  );
  const totalDailyFinalAmount = salesDays.reduce(
    (sum, day) => sum + getDailyFinalAmount(day),
    0
  );
  const averageDailyFinalAmount =
    salesDays.length > 0 ? totalDailyFinalAmount / salesDays.length : 0;
  const hasError = Boolean(errorMessage);

  const summaryCards = useMemo(
    () => [
      {
        label: monthlyText.totalSales,
        value: isLoading
          ? monthlyText.loading
          : hasError
            ? monthlyText.error
            : formatVnd(summary?.totalSales),
        meta: monthlyText.paidReceiptBase,
      },
      {
        label: monthlyText.receipts,
        value: isLoading
          ? monthlyText.loading
          : hasError
            ? monthlyText.error
            : `${formatNumber(summary?.receiptCount)}${monthlyText.receiptCountSuffix}`,
        meta: `${monthlyText.averageReceiptAmount} ${formatVnd(summary?.averageReceiptAmount)}`,
      },
    ],
    [hasError, isLoading, monthlyText, summary]
  );

  const paymentRows = useMemo(
    () => [
      { label: monthlyText.cash, value: formatVnd(paymentSummary?.cashAmount) },
      {
        label: monthlyText.transfer,
        value: formatVnd(paymentSummary?.transferAmount),
      },
      { label: monthlyText.card, value: formatVnd(paymentSummary?.cardAmount) },
      { label: monthlyText.other, value: formatVnd(paymentSummary?.otherAmount) },
    ],
    [monthlyText, paymentSummary]
  );

  return (
    <Container noPaddingTop>
      <SubNav tabs={tabs} />

      <div style={sectionStyle}>
        <section style={noticeCardStyle}>
          <div style={noticeHeaderStyle}>
            <span style={noticeBadgeStyle}>{monthlyText.badge}</span>
            <span style={noticeTitleStyle}>{monthlyText.title}</span>
          </div>
          <div style={monthControlStyle}>
            <button
              type="button"
              onClick={() => handleMonthChange(shiftMonth(month, -1))}
              style={monthButtonStyle}
            >
              {monthlyText.previousMonth}
            </button>
            <input
              type="month"
              value={month}
              onChange={(event) => handleMonthChange(event.target.value)}
              style={monthInputStyle}
            />
            <button
              type="button"
              onClick={() => handleMonthChange(shiftMonth(month, 1))}
              style={monthButtonStyle}
            >
              {monthlyText.nextMonth}
            </button>
          </div>
          {errorMessage ? <p style={errorTextStyle}>{errorMessage}</p> : null}
        </section>

        <section style={summaryGridStyle}>
          {summaryCards.map((card) => (
            <SummaryCard
              key={card.label}
              label={card.label}
              value={card.value}
              meta={card.meta}
            />
          ))}
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{monthlyText.paymentSummary}</h2>
            <span style={sectionMetaStyle}>{monthlyText.paymentTotal}</span>
          </div>

          <div style={paymentMethodGridStyle}>
            {paymentRows.map((row) => (
              <div key={row.label} style={paymentMethodStyle}>
                <span style={paymentMethodLabelStyle}>{row.label}</span>
                <strong style={paymentMethodValueStyle}>
                  {isLoading ? monthlyText.loading : hasError ? monthlyText.error : row.value}
                </strong>
              </div>
            ))}
          </div>

          <div style={paymentTotalStyle}>
            <span style={paymentTotalLabelStyle}>{monthlyText.paymentTotal}</span>
            <strong style={paymentTotalValueStyle}>
              {isLoading
                ? monthlyText.loading
                : hasError
                  ? monthlyText.error
                  : formatVnd(paymentSummary?.paymentTotalAmount)}
            </strong>
          </div>
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{monthlyText.taxSummary}</h2>
            <span style={sectionMetaStyle}>
              {monthlyText.totalTax} {isLoading ? "-" : formatVnd(taxSummary?.totalTaxAmount)}
            </span>
          </div>

          <TaxSummaryList
            isLoading={isLoading}
            hasError={hasError}
            text={monthlyText}
            taxByRate={taxSummary?.taxByRate || []}
            taxSavingAmount={taxSummary?.taxSavingAmount || 0}
          />
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{monthlyText.dailySales}</h2>
            <span style={sectionMetaStyle}>
              {monthlyText.dailyAverageSales} {formatVnd(averageDailyFinalAmount)}
            </span>
          </div>

          <DailySalesList
            isLoading={isLoading}
            hasError={hasError}
            text={monthlyText}
            totalFinalSales={totalDailyFinalAmount}
            days={days}
          />
        </section>
      </div>
    </Container>
  );
}

function SummaryCard({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <div style={summaryCardStyle}>
      <div style={summaryLabelStyle}>{label}</div>
      <div style={summaryValueStyle}>{value}</div>
      <div style={summaryMetaStyle}>{meta}</div>
    </div>
  );
}

function TaxSummaryList({
  isLoading,
  hasError,
  text,
  taxByRate,
  taxSavingAmount,
}: {
  isLoading: boolean;
  hasError: boolean;
  text: SalesMonthlyViewText;
  taxByRate: TaxSummary["taxByRate"];
  taxSavingAmount: number;
}) {
  if (isLoading) {
    return <EmptyState title={text.loading} text={text.taxDataLoading} />;
  }

  if (hasError) {
    return <EmptyState title={text.error} text={text.taxDataLoadFailed} />;
  }

  return (
    <div style={itemListStyle}>
      {taxByRate.length === 0 ? (
        <div style={taxRowStyle}>
          <span style={taxRateStyle}>{text.vat}</span>
          <strong style={statusValueStyle}>{formatVnd(0)}</strong>
          <span style={taxLineCountStyle}>{text.noTaxData}</span>
        </div>
      ) : (
        taxByRate.map((item) => (
          <div key={item.taxRate} style={taxRowStyle}>
            <span style={taxRateStyle}>
              {text.vat} {formatNumber(item.taxRate)}%
            </span>
            <strong style={statusValueStyle}>{formatVnd(item.taxAmount)}</strong>
            <span style={taxLineCountStyle}>
              {formatNumber(item.lineCount)}{text.itemCountSuffix}
            </span>
          </div>
        ))
      )}
      <div style={taxRowStyle}>
        <span style={taxRateStyle}>{text.taxSaving}</span>
        <strong style={statusValueStyle}>{formatVnd(taxSavingAmount)}</strong>
        <span style={taxLineCountStyle}>{text.adjustedReceiptBase}</span>
      </div>
    </div>
  );
}

function DailySalesList({
  isLoading,
  hasError,
  text,
  totalFinalSales,
  days,
}: {
  isLoading: boolean;
  hasError: boolean;
  text: SalesMonthlyViewText;
  totalFinalSales: number;
  days: MonthlyDay[];
}) {
  if (isLoading) {
    return <EmptyState title={text.loading} text={text.dailyDataLoading} />;
  }

  if (hasError) {
    return <EmptyState title={text.error} text={text.dailyDataLoadFailed} />;
  }

  if (days.length === 0) {
    return <EmptyState title={text.noData} text={text.noMonthlySalesData} />;
  }

  const activeDays = days.filter(
    (day) => day.receiptCount > 0 || getDailyFinalAmount(day) > 0
  );
  const activeSalesAmounts = activeDays.map(getDailyFinalAmount);
  const maxSales =
    activeSalesAmounts.length > 0 ? Math.max(...activeSalesAmounts) : 0;
  const minSales =
    activeSalesAmounts.length > 0 ? Math.min(...activeSalesAmounts) : 0;
  const hasSingleActiveDay = activeDays.length === 1;

  return (
    <div style={itemListStyle}>
      {days.map((day) => {
        const salesAmount = getDailyFinalAmount(day);
        const ratio = totalFinalSales > 0 ? (salesAmount / totalFinalSales) * 100 : 0;
        const barWidth = `${Math.min(Math.max(ratio, 0), 100)}%`;
        const isActiveDay = day.receiptCount > 0 || salesAmount > 0;
        const normalized =
          isActiveDay && maxSales === minSales
            ? 0.55
            : isActiveDay && maxSales > minSales
              ? (salesAmount - minSales) / (maxSales - minSales)
              : 0;
        const rowBackground = `rgba(79, 70, 229, ${0.035 + normalized * 0.11})`;
        const barBackground = `rgba(79, 70, 229, ${0.32 + normalized * 0.5})`;
        const isBestDay = isActiveDay && salesAmount === maxSales;
        const isWorstDay =
          isActiveDay && !hasSingleActiveDay && salesAmount === minSales;
        const weekday = getWeekdayInfo(day.businessDate, text.weekdays);

        return (
          <div
            key={day.businessDate}
            style={{ ...dayRowStyle, background: rowBackground }}
          >
            <div style={dayRowContentStyle}>
              <strong style={dayDateStyle}>
                <span>{day.businessDate}</span>
                <span style={getWeekdayStyle(weekday.tone)}>
                  ({weekday.label})
                </span>
                {isBestDay ? <span style={dayMarkerStyle}>🔥</span> : null}
                {isWorstDay ? <span style={dayMarkerStyle}>❄️</span> : null}
              </strong>
              <strong style={dayAmountStyle}>{formatVnd(salesAmount)}</strong>
              <span style={dayReceiptStyle}>
                {formatNumber(day.receiptCount)}{text.receiptCountSuffix}
              </span>
              <span style={dayRatioStyle}>{formatNumber(ratio)}%</span>
            </div>
            <div style={dayBarTrackStyle}>
              <div
                style={{
                  ...dayBarFillStyle,
                  width: barWidth,
                  background: barBackground,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div style={emptyBoxStyle}>
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const noticeCardStyle: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  background: "#f9fafb",
  border: "1px solid #e5e7eb",
};

const noticeHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 6,
};

const noticeBadgeStyle: CSSProperties = {
  ...ui.badgeMini,
  minWidth: 0,
  background: "#111827",
};

const noticeTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#111827",
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

const errorTextStyle: CSSProperties = {
  margin: "8px 0 0",
  fontSize: 12,
  lineHeight: 1.45,
  color: "#dc2626",
  fontWeight: 700,
};

const summaryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

const summaryCardStyle: CSSProperties = {
  ...ui.card,
  padding: 12,
  minWidth: 0,
};

const summaryLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#6b7280",
  marginBottom: 6,
  lineHeight: 1.2,
};

const summaryValueStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 900,
  color: "#111827",
  lineHeight: 1.2,
};

const summaryMetaStyle: CSSProperties = {
  ...ui.metaText,
  marginTop: 6,
  fontWeight: 700,
};

const cardStyle: CSSProperties = {
  ...ui.card,
  padding: 14,
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 10,
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 900,
  color: "#111827",
};

const sectionMetaStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const paymentMethodGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 6,
};

const paymentMethodStyle: CSSProperties = {
  padding: "8px 9px",
  border: "1px solid #eef0f3",
  borderRadius: 10,
  background: "#f9fafb",
  minWidth: 0,
};

const paymentMethodLabelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  lineHeight: 1.25,
  fontWeight: 700,
  color: "#6b7280",
};

const paymentMethodValueStyle: CSSProperties = {
  display: "block",
  marginTop: 4,
  fontSize: 12,
  lineHeight: 1.25,
  fontWeight: 900,
  color: "#111827",
  wordBreak: "break-word",
};

const paymentTotalStyle: CSSProperties = {
  marginTop: 8,
  padding: "9px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 10,
  background: "#111827",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
};

const paymentTotalLabelStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.3,
  fontWeight: 800,
  color: "#e5e7eb",
};

const paymentTotalValueStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.3,
  fontWeight: 900,
  color: "#ffffff",
};

const itemListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const statusValueStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#111827",
};

const taxRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "72px 1fr auto",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  border: "1px solid #eef0f3",
  borderRadius: 10,
  background: "#f9fafb",
};

const taxRateStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 900,
  color: "#374151",
};

const taxLineCountStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const dayRowStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  padding: "8px 9px",
  border: "1px solid #eef0f3",
  borderRadius: 8,
  background: "#f9fafb",
};

const dayRowContentStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "grid",
  gridTemplateColumns: "126px minmax(82px, 1fr) 44px 48px",
  alignItems: "center",
  gap: 6,
};

const dayDateStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 12,
  fontWeight: 900,
  color: "#111827",
  whiteSpace: "nowrap",
};

const weekdayTextStyle: CSSProperties = {
  color: "#6b7280",
};

const saturdayTextStyle: CSSProperties = {
  color: "#2563eb",
};

const sundayTextStyle: CSSProperties = {
  color: "#dc2626",
};

const dayMarkerStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1,
};

const dayAmountStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.25,
  fontWeight: 900,
  color: "#111827",
  textAlign: "right",
  minWidth: 0,
  wordBreak: "break-word",
};

const dayReceiptStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.25,
  fontWeight: 800,
  color: "#6b7280",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const dayRatioStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1.25,
  fontWeight: 900,
  color: "#3730a3",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const dayBarTrackStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  height: 3,
  background: "#e5e7eb",
};

const dayBarFillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "#4f46e5",
};

const emptyBoxStyle: CSSProperties = {
  border: "1px dashed #d1d5db",
  borderRadius: 10,
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  color: "#6b7280",
  fontSize: 13,
};
