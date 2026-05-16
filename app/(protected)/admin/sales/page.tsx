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
  {
    href: "/admin/sales",
    key: "daily",
  },
  {
    href: "/admin/sales/receipts",
    key: "receipts",
  },
  {
    href: "/admin/sales/monthly",
    key: "monthly",
  },
] as const;

type SalesDailyText = (typeof salesText)[keyof typeof salesText]["daily"];
type SalesCommonText = (typeof salesText)[keyof typeof salesText]["common"];
type CommonText = (typeof commonText)[keyof typeof commonText];
type SalesDailyViewText = SalesCommonText &
  SalesDailyText &
  Pick<
    CommonText,
    | "noData"
    | "loading"
    | "error"
    | "loadFailed"
    | "cash"
    | "transfer"
    | "card"
    | "totalTax"
    | "vat"
    | "options"
    | "canceled"
  > & {
    other: CommonText["etc"];
    paymentCompleted: CommonText["paid"];
  };

type SalesTodayResponse = {
  ok: boolean;
  businessDate?: string;
  error?: string;
  summary?: {
    totalSales: number;
    receiptCount: number;
    paidReceiptCount: number;
    canceledReceiptCount: number;
    lineCount: number;
    salesLineCount: number;
    optionLineCount: number;
    averageReceiptAmount: number;
    deductionTargetLineCount: number;
  };
  status?: {
    paid: number;
    canceled: number;
    needsReview: number;
    unchecked: number;
    checked: number;
  };
  paymentSummary?: {
    cashAmount: number;
    transferAmount: number;
    cardAmount: number;
    otherAmount: number;
    paymentTotalAmount: number;
  };
  taxSummary?: {
    totalTaxAmount: number;
    taxSavingAmount: number;
    taxByRate: {
      taxRate: number;
      taxAmount: number;
      lineCount: number;
    }[];
  };
  hourlySales?: {
    hour: string;
    amount: number;
    receiptCount: number;
  }[];
  topItems?: {
    itemCode: string;
    itemName: string;
    quantity: number;
    amount: number;
  }[];
};

type SalesSyncResponse = {
  ok: boolean;
  error?: string;
  result?: {
    invoiceCount?: number;
    lineCount?: number;
    receiptCreatedCount?: number;
    receiptUpdatedCount?: number;
    lineCreatedCount?: number;
    lineUpdatedCount?: number;
  };
};

function getStoredActor() {
  if (typeof window === "undefined") {
    return { actorUsername: "" };
  }

  try {
    const raw = window.localStorage.getItem("baba_user");
    if (!raw) return { actorUsername: "" };

    const user = JSON.parse(raw) as {
      username?: string;
    };

    return {
      actorUsername: user.username || "",
    };
  } catch {
    return { actorUsername: "" };
  }
}

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

export default function SalesPage() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { lang } = useLanguage();
  const t = salesText[lang];
  const c = commonText[lang];
  const s = t.common;
  const dailyText = useMemo(
    () => ({
      ...s,
      ...t.daily,
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
      options: c.options,
      canceled: c.canceled,
      paymentCompleted: c.paid,
    }),
    [c, s, t.daily]
  );
  const initialBusinessDate = searchParams.get("businessDate") || getBusinessDate();
  const [businessDate, setBusinessDate] = useState(initialBusinessDate);
  const [salesData, setSalesData] = useState<SalesTodayResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [syncMessage, setSyncMessage] = useState("");

  const tabs = salesTabs.map((tab) => {
    const href = `${tab.href}?businessDate=${encodeURIComponent(businessDate)}`;

    return {
      label: t.tabs[tab.key],
      href,
      active:
        tab.href === "/admin/sales"
          ? pathname === "/admin/sales" || pathname === "/admin/sales/"
          : pathname.startsWith(tab.href),
    };
  });

  const fetchSalesToday = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      setErrorMessage("");

      try {
        const query = businessDate
          ? `?businessDate=${encodeURIComponent(businessDate)}`
          : "";
        const res = await fetch(`/api/admin/sales/today${query}`, {
          cache: "no-store",
          signal,
        });
        const result = (await res.json()) as SalesTodayResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || dailyText.loadFailed);
        }

        setSalesData(result);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setErrorMessage(
          error instanceof Error
            ? error.message
            : dailyText.loadFailed
        );
        setSalesData(null);
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    [businessDate, dailyText.loadFailed]
  );

  useEffect(() => {
    const controller = new AbortController();

    fetchSalesToday(controller.signal);

    return () => controller.abort();
  }, [fetchSalesToday]);

  function handleBusinessDateChange(value: string) {
    setBusinessDate(value);
    setSyncMessage("");
    router.replace(`${pathname}?businessDate=${encodeURIComponent(value)}`, {
      scroll: false,
    });
  }

  async function handleSyncSales() {
    const actor = getStoredActor();

    if (!actor.actorUsername) {
      setErrorMessage(`${dailyText.noLogin}. ${c.loginAgain}`);
      setSyncMessage("");
      return;
    }

    setIsSyncing(true);
    setErrorMessage("");
    setSyncMessage("");

    try {
      const body: {
        businessDate?: string;
        limit: number;
        actorUsername: string;
      } = {
        limit: 100,
        actorUsername: actor.actorUsername,
      };

      if (businessDate.trim()) {
        body.businessDate = businessDate.trim();
      }

      const res = await fetch("/api/admin/sales/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const result = (await res.json().catch(() => null)) as
        | SalesSyncResponse
        | null;

      if (!res.ok || !result?.ok) {
        throw new Error(
          result?.error || dailyText.syncFailed
        );
      }

      const receiptCount = result.result?.invoiceCount || 0;
      const lineCount = result.result?.lineCount || 0;

      setSyncMessage(
        `${dailyText.syncSuccess}: ${dailyText.receipts} ${formatNumber(receiptCount)}${dailyText.receiptCountSuffix}, ${dailyText.soldItems} ${formatNumber(lineCount)}${dailyText.itemCountSuffix}`
      );

      await fetchSalesToday();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : dailyText.syncFailed
      );
    } finally {
      setIsSyncing(false);
    }
  }

  const summary = salesData?.summary;
  const paymentSummary = salesData?.paymentSummary;
  const taxSummary = salesData?.taxSummary;
  const hasError = Boolean(errorMessage);

  const summaryCards = useMemo(
    () => [
      {
        label: dailyText.totalSales,
        value: isLoading
          ? dailyText.loading
          : hasError
            ? dailyText.error
            : formatVnd(summary?.totalSales),
        meta: dailyText.paidReceiptBase,
      },
      {
        label: dailyText.receipts,
        value: isLoading
          ? dailyText.loading
          : hasError
            ? dailyText.error
            : `${formatNumber(summary?.receiptCount)}${dailyText.receiptCountSuffix}`,
        meta: `${dailyText.paymentCompleted} ${formatNumber(summary?.paidReceiptCount)} / ${dailyText.canceled} ${formatNumber(summary?.canceledReceiptCount)}`,
      },
      {
        label: dailyText.soldItems,
        value: isLoading
          ? dailyText.loading
          : hasError
            ? dailyText.error
            : `${formatNumber(summary?.salesLineCount)}${dailyText.itemCountSuffix}`,
        meta: `${dailyText.options} ${formatNumber(summary?.optionLineCount)}${dailyText.itemCountSuffix}`,
      },
      {
        label: dailyText.averageReceiptAmount,
        value: isLoading
          ? dailyText.loading
          : hasError
            ? dailyText.error
            : formatVnd(summary?.averageReceiptAmount),
        meta: dailyText.paidReceiptBase,
      },
    ],
    [dailyText, hasError, isLoading, summary]
  );

  const paymentRows = useMemo(
    () => [
      {
        label: dailyText.cash,
        value: formatVnd(paymentSummary?.cashAmount),
      },
      {
        label: dailyText.transfer,
        value: formatVnd(paymentSummary?.transferAmount),
      },
      {
        label: dailyText.card,
        value: formatVnd(paymentSummary?.cardAmount),
      },
      {
        label: dailyText.other,
        value: formatVnd(paymentSummary?.otherAmount),
      },
    ],
    [dailyText, paymentSummary]
  );

  return (
    <Container noPaddingTop>
      <SubNav tabs={tabs} />

      <div style={sectionStyle}>
        <section style={noticeCardStyle}>
          <div style={noticeHeaderStyle}>
            <span style={noticeBadgeStyle}>{dailyText.badge}</span>
            <span style={noticeTitleStyle}>{dailyText.title}</span>
          </div>
          <div style={dateFilterStyle}>
            <label style={dateInputWrapStyle}>
              <input
                type="date"
                value={businessDate}
                onChange={(event) => handleBusinessDateChange(event.target.value)}
                style={dateInputStyle}
              />
            </label>
            <button
              type="button"
              onClick={handleSyncSales}
              disabled={isSyncing}
              style={{
                ...syncButtonStyle,
                ...(isSyncing ? syncButtonDisabledStyle : null),
              }}
            >
              {isSyncing ? `${dailyText.syncing}...` : dailyText.syncButton}
            </button>
          </div>
          {syncMessage ? <p style={successTextStyle}>{syncMessage}</p> : null}
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
            <h2 style={sectionTitleStyle}>{dailyText.paymentSummary}</h2>
            <span style={sectionMetaStyle}>{dailyText.paymentBase}</span>
          </div>

          <div style={paymentMethodGridStyle}>
            {paymentRows.map((row) => (
              <div key={row.label} style={paymentMethodStyle}>
                <span style={paymentMethodLabelStyle}>{row.label}</span>
                <strong style={paymentMethodValueStyle}>
                  {isLoading ? dailyText.loading : hasError ? dailyText.error : row.value}
                </strong>
              </div>
            ))}
          </div>

          <div style={paymentTotalStyle}>
            <span style={paymentTotalLabelStyle}>{dailyText.paymentTotal}</span>
            <strong style={paymentTotalValueStyle}>
              {isLoading
                ? dailyText.loading
                : hasError
                  ? dailyText.error
                  : formatVnd(paymentSummary?.paymentTotalAmount)}
            </strong>
          </div>
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{dailyText.taxSummary}</h2>
            <span style={sectionMetaStyle}>
              {dailyText.totalTax} {isLoading ? "-" : formatVnd(taxSummary?.totalTaxAmount)}
            </span>
          </div>

          <TaxSummaryList
            isLoading={isLoading}
            hasError={hasError}
            text={dailyText}
            taxByRate={taxSummary?.taxByRate || []}
            taxSavingAmount={taxSummary?.taxSavingAmount || 0}
          />
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{dailyText.hourlySales}</h2>
            <span style={sectionMetaStyle}>{dailyText.businessDayBase}</span>
          </div>

          <HourlySalesList
            isLoading={isLoading}
            hourlySales={salesData?.hourlySales || []}
            text={dailyText}
          />
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{dailyText.topItems}</h2>
            <span style={sectionMetaStyle}>{dailyText.soldItemBase}</span>
          </div>

          <TopItemsList
            isLoading={isLoading}
            text={dailyText}
            topItems={salesData?.topItems || []}
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
  text: SalesDailyViewText;
  taxByRate: NonNullable<SalesTodayResponse["taxSummary"]>["taxByRate"];
  taxSavingAmount: number;
}) {
  if (isLoading) {
    return <EmptyState title={text.loading} text={text.taxDataLoading} />;
  }

  if (hasError) {
    return <EmptyState title={text.error} text={text.taxDataLoadFailed} />;
  }

  if (taxByRate.length === 0) {
    return <EmptyState title={text.noData} text={text.noTaxData} />;
  }

  return (
    <div style={itemListStyle}>
      {taxByRate.map((item) => (
        <div key={item.taxRate} style={taxRowStyle}>
          <span style={taxRateStyle}>
            {text.vat} {formatNumber(item.taxRate)}%
          </span>
          <strong style={statusValueStyle}>{formatVnd(item.taxAmount)}</strong>
          <span style={taxLineCountStyle}>
            {formatNumber(item.lineCount)}{text.itemCountSuffix}
          </span>
        </div>
      ))}
      <div style={taxRowStyle}>
        <span style={taxRateStyle}>{text.taxSaving}</span>
        <strong style={statusValueStyle}>{formatVnd(taxSavingAmount)}</strong>
        <span style={taxLineCountStyle}>{text.adjustedReceiptBase}</span>
      </div>
    </div>
  );
}

function HourlySalesList({
  isLoading,
  text,
  hourlySales,
}: {
  isLoading: boolean;
  text: SalesDailyViewText;
  hourlySales: NonNullable<SalesTodayResponse["hourlySales"]>;
}) {
  if (isLoading) {
    return <EmptyState title={text.loading} text={text.hourlyDataLoading} />;
  }

  if (hourlySales.length === 0) {
    return <EmptyState title={text.noData} text={text.noHourlySalesData} />;
  }

  const maxAmount = Math.max(...hourlySales.map((item) => item.amount), 1);

  return (
    <div style={itemListStyle}>
      {hourlySales.map((item) => {
        const width = `${Math.max((item.amount / maxAmount) * 100, 5)}%`;

        return (
          <div key={item.hour} style={hourlyRowStyle}>
            <div style={hourlyTopRowStyle}>
              <span style={hourLabelStyle}>{item.hour}</span>
              <strong style={statusValueStyle}>{formatVnd(item.amount)}</strong>
            </div>
            <div style={barTrackStyle}>
              <div style={{ ...barFillStyle, width }} />
            </div>
            <div style={hourMetaStyle}>
              {formatNumber(item.receiptCount)}{text.receiptCountSuffix}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TopItemsList({
  isLoading,
  text,
  topItems,
}: {
  isLoading: boolean;
  text: SalesDailyViewText;
  topItems: NonNullable<SalesTodayResponse["topItems"]>;
}) {
  if (isLoading) {
    return <EmptyState title={text.loading} text={text.topItemsLoading} />;
  }

  if (topItems.length === 0) {
    return <EmptyState title={text.noData} text={text.noTopItemsData} />;
  }

  return (
    <div style={itemListStyle}>
      {topItems.map((item, index) => (
        <div key={`${item.itemCode}-${item.itemName}`} style={itemRowStyle}>
          <span style={itemRankStyle}>{index + 1}</span>
          <div style={itemContentStyle}>
            <span style={itemNameStyle}>{item.itemName || "-"}</span>
            <span style={itemMetaStyle}>
              {formatNumber(item.quantity)}{text.itemCountSuffix} · {formatVnd(item.amount)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div style={emptyBoxStyle}>
      <div style={emptyTitleStyle}>{title}</div>
      <p style={emptyTextStyle}>{text}</p>
    </div>
  );
}

const sectionStyle: CSSProperties = {
  display: "grid",
  gap: 12,
};

const cardStyle: CSSProperties = {
  ...ui.card,
  padding: 14,
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

const errorTextStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  lineHeight: 1.45,
  color: "#dc2626",
  fontWeight: 700,
};

const dateFilterStyle: CSSProperties = {
  marginTop: 8,
  display: "grid",
  gap: 8,
};

const dateInputWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
};

const dateInputStyle: CSSProperties = {
  ...ui.input,
  padding: "9px 10px",
  fontSize: 13,
  borderRadius: 10,
};

const syncButtonStyle: CSSProperties = {
  ...ui.button,
  padding: "10px 12px",
  fontSize: 13,
  borderRadius: 10,
  fontWeight: 800,
};

const syncButtonDisabledStyle: CSSProperties = {
  opacity: 0.65,
  cursor: "not-allowed",
};

const successTextStyle: CSSProperties = {
  margin: "7px 0 0",
  fontSize: 12,
  lineHeight: 1.45,
  color: "#047857",
  fontWeight: 800,
};

const summaryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 8,
};

const summaryCardStyle: CSSProperties = {
  ...ui.card,
  padding: "11px 10px",
  minHeight: 88,
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

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 10,
};

const sectionTitleStyle: CSSProperties = {
  ...ui.sectionTitle,
  fontSize: 15,
  margin: 0,
};

const sectionMetaStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#9ca3af",
  whiteSpace: "nowrap",
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

const emptyBoxStyle: CSSProperties = {
  border: "1px dashed #d1d5db",
  background: "#f9fafb",
  borderRadius: 12,
  padding: 14,
  textAlign: "center",
};

const emptyTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#374151",
  marginBottom: 5,
};

const emptyTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.45,
  color: "#6b7280",
  fontWeight: 700,
};

const itemListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const itemRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  border: "1px solid #eef0f3",
  borderRadius: 10,
  background: "#f9fafb",
};

const itemRankStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 999,
  background: "#111827",
  color: "#ffffff",
  fontSize: 11,
  fontWeight: 800,
  flexShrink: 0,
};

const itemNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#374151",
  lineHeight: 1.35,
};

const itemContentStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const itemMetaStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 700,
};

const hourlyRowStyle: CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #eef0f3",
  borderRadius: 10,
  background: "#f9fafb",
};

const hourlyTopRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 6,
};

const hourLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "#374151",
};

const hourMetaStyle: CSSProperties = {
  ...ui.metaText,
  marginTop: 5,
  fontWeight: 700,
};

const barTrackStyle: CSSProperties = {
  width: "100%",
  height: 7,
  borderRadius: 999,
  background: "#e5e7eb",
  overflow: "hidden",
};

const barFillStyle: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: "#111827",
};
