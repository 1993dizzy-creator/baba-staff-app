"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { ui } from "@/lib/styles/ui";

const salesTabs = [
  {
    href: "/admin/sales",
    label: "일간현황",
  },
  {
    href: "/admin/sales/receipts",
    label: "영수증",
  },
  {
    href: "/admin/sales/monthly",
    label: "월간현황",
  },
];

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
  const [businessDate, setBusinessDate] = useState("");
  const [salesData, setSalesData] = useState<SalesTodayResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const tabs = salesTabs.map((tab) => ({
    ...tab,
    active:
      tab.href === "/admin/sales"
        ? pathname === "/admin/sales" || pathname === "/admin/sales/"
        : pathname.startsWith(tab.href),
  }));

  useEffect(() => {
    const controller = new AbortController();

    const fetchSalesToday = async () => {
      setIsLoading(true);
      setErrorMessage("");

      try {
        const query = businessDate
          ? `?businessDate=${encodeURIComponent(businessDate)}`
          : "";
        const res = await fetch(`/api/admin/sales/today${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await res.json()) as SalesTodayResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || "매출 데이터를 불러오지 못했습니다.");
        }

        setSalesData(result);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        setErrorMessage(
          error instanceof Error
            ? error.message
            : "매출 데이터를 불러오지 못했습니다."
        );
        setSalesData(null);
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    fetchSalesToday();

    return () => controller.abort();
  }, [businessDate]);

  const summary = salesData?.summary;
  const status = salesData?.status;
  const hasError = Boolean(errorMessage);

  const summaryCards = useMemo(
    () => [
      {
        label: "💰 일 매출",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : formatVnd(summary?.totalSales),
        meta: "POS 결제 완료 기준",
      },
      {
        label: "🧾 영수증",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : `${formatNumber(summary?.receiptCount)}건`,
        meta: `결제 완료 ${formatNumber(summary?.paidReceiptCount)} / 취소 ${formatNumber(summary?.canceledReceiptCount)}`,
      },
      {
        label: "🍽️ 판매 라인",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : `${formatNumber(summary?.salesLineCount)}개`,
        meta: `옵션 ${formatNumber(summary?.optionLineCount)}개`,
      },
      {
        label: "🧮 객단가",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : formatVnd(summary?.averageReceiptAmount),
        meta: "매출 ÷ 결제 완료 영수증",
      },
    ],
    [hasError, isLoading, summary]
  );

  const statusRows = useMemo(
    () => [
      {
        label: "결제 완료",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : `${formatNumber(status?.paid)}건`,
      },
      {
        label: "취소/환불",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : `${formatNumber(status?.canceled)}건`,
      },
      {
        label: "미확인",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : `${formatNumber(status?.unchecked)}건`,
      },
      {
        label: "확인 완료",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : `${formatNumber(status?.checked)}건`,
      },
      {
        label: "검토 필요",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : `${formatNumber(status?.needsReview)}건`,
      },
      {
        label: "재고 차감 대상",
        value: isLoading
          ? "불러오는 중"
          : hasError
            ? "오류"
            : `${formatNumber(summary?.deductionTargetLineCount)}개`,
      },
    ],
    [hasError, isLoading, status, summary]
  );

  return (
    <Container noPaddingTop>
      <SubNav tabs={tabs} />

      <div style={sectionStyle}>
        <section style={noticeCardStyle}>
          <div style={noticeHeaderStyle}>
            <span style={noticeBadgeStyle}>TODAY</span>
            <span style={noticeTitleStyle}>일간현황</span>
          </div>
          <div style={dateFilterStyle}>
            <label style={dateInputWrapStyle}>
              <input
                type="date"
                value={businessDate}
                onChange={(event) => setBusinessDate(event.target.value)}
                style={dateInputStyle}
              />
            </label>
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
          <h2 style={sectionTitleStyle}>📌 일간 판매 상태</h2>

          <div style={statusListStyle}>
            {statusRows.map((row) => (
              <div key={row.label} style={statusRowStyle}>
                <span style={statusLabelStyle}>{row.label}</span>
                <strong style={statusValueStyle}>{row.value}</strong>
              </div>
            ))}
          </div>
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>⏰ 시간대별 매출</h2>
            <span style={sectionMetaStyle}>영업일 기준</span>
          </div>

          <HourlySalesList
            isLoading={isLoading}
            hourlySales={salesData?.hourlySales || []}
          />
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>🏆 많이 팔린 상품</h2>
            <span style={sectionMetaStyle}>판매라인 기준</span>
          </div>

          <TopItemsList
            isLoading={isLoading}
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

function HourlySalesList({
  isLoading,
  hourlySales,
}: {
  isLoading: boolean;
  hourlySales: NonNullable<SalesTodayResponse["hourlySales"]>;
}) {
  if (isLoading) {
    return (
      <EmptyState
        title="불러오는 중"
        text="시간대별 매출 데이터를 불러오고 있습니다."
      />
    );
  }

  if (hourlySales.length === 0) {
    return (
      <EmptyState
        title="데이터 없음"
        text="동기화된 매출 데이터가 없습니다."
      />
    );
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
            <div style={hourMetaStyle}>{formatNumber(item.receiptCount)}건</div>
          </div>
        );
      })}
    </div>
  );
}

function TopItemsList({
  isLoading,
  topItems,
}: {
  isLoading: boolean;
  topItems: NonNullable<SalesTodayResponse["topItems"]>;
}) {
  if (isLoading) {
    return (
      <EmptyState
        title="불러오는 중"
        text="많이 팔린 상품 데이터를 불러오고 있습니다."
      />
    );
  }

  if (topItems.length === 0) {
    return (
      <EmptyState
        title="데이터 없음"
        text="동기화된 상품 판매 데이터가 없습니다."
      />
    );
  }

  return (
    <div style={itemListStyle}>
      {topItems.map((item, index) => (
        <div key={`${item.itemCode}-${item.itemName}`} style={itemRowStyle}>
          <span style={itemRankStyle}>{index + 1}</span>
          <div style={itemContentStyle}>
            <span style={itemNameStyle}>{item.itemName || "-"}</span>
            <span style={itemMetaStyle}>
              {formatNumber(item.quantity)}개 · {formatVnd(item.amount)}
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

const statusListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  marginTop: 10,
};

const statusRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "9px 10px",
  border: "1px solid #eef0f3",
  borderRadius: 10,
  background: "#f9fafb",
};

const statusLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#374151",
};

const statusValueStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 900,
  color: "#111827",
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
