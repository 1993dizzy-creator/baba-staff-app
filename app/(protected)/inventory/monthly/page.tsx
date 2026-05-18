"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { ui } from "@/lib/styles/ui";
import { useLanguage } from "@/lib/language-context";
import { commonText } from "@/lib/text";
import { getInventoryTabs } from "@/lib/navigation/inventory-tabs";

type MonthlyItemStatus = "existing" | "new" | "missing";

type MonthlyDay = {
  businessDate: string;
  purchaseQuantity: number;
  purchaseLogCount: number;
  stockCheckNetChange: number;
  serviceNetChange: number;
  otherNetChange: number;
  totalLogNetChange: number;
};

type MonthlyItem = {
  itemId: number;
  code: string | null;
  name: string;
  nameVi: string | null;
  unit: string | null;
  supplier: string | null;
  part: string | null;
  category: string | null;
  categoryVi: string | null;
  baselineQuantity: number | null;
  latestQuantity: number | null;
  stockNetChange: number;
  baselinePurchasePrice: number | null;
  latestPurchasePrice: number | null;
  purchasePriceUsed: number | null;
  purchasePriceDiff: number | null;
  purchaseQuantity: number;
  purchaseLogCount: number;
  purchaseAmount: number | null;
  stockCheckNetChange: number;
  serviceNetChange: number;
  otherNetChange: number;
  totalLogNetChange: number;
  status: MonthlyItemStatus;
};

type MonthlyInventoryResponse = {
  ok: true;
  month: string;
  range: {
    fromDate: string;
    toDate: string;
  };
  baseline: {
    snapshotId: number | null;
    snapshotDate: string | null;
  };
  latest: {
    snapshotId: number | null;
    snapshotDate: string | null;
  };
  summary: {
    stockNetChange: number;
    purchaseQuantity: number;
    purchaseLogCount: number;
    purchaseItemCount: number;
    purchaseAmountKnown: number;
    purchaseAmountMissingCount: number;
    stockCheckNetChange: number;
    serviceNetChange: number;
    otherNetChange: number;
    unclassifiedLogCount: number;
  };
  days: MonthlyDay[];
  items: MonthlyItem[];
};

type ErrorResponse = {
  ok: false;
  message?: string;
};

const monthlyText = {
  ko: {
    title: "월간재고현황",
    titleVi: "Tổng quan tháng",
    month: "월 선택",
    refresh: "새로고침",
    baseRange: "기준",
    noSnapshot: "기준 스냅샷 없음",
    summary: "월간 요약",
    stockNetChange: "재고 순변동",
    purchaseQuantity: "구매입고 수량",
    purchaseAmountKnown: "구매입고 금액",
    purchaseAmountMissing: "단가 누락",
    stockCheckNetChange: "재고확인",
    serviceNetChange: "서비스/증정",
    otherNetChange: "기타",
    unclassifiedLogCount: "미분류",
    dailyFlow: "일자별 흐름",
    noMovements: "이번 달 변동 내역이 없습니다.",
    itemSummary: "품목별 월간 요약",
    noItems: "표시할 품목이 없습니다.",
    supplier: "거래처",
    purchase: "입고",
    amount: "금액",
    unitPrice: "단가",
    priceNotSet: "단가 미등록",
    existing: "기존",
    new: "신규",
    missing: "누락",
    guide:
      "재고 순변동은 기준 스냅샷과 최신 스냅샷 차이이며, 입고/재고확인/서비스/기타는 API가 집계한 로그 값을 표시합니다.",
  },
  vi: {
    title: "Tổng quan tháng",
    titleVi: "월간재고현황",
    month: "Tháng",
    refresh: "Tải lại",
    baseRange: "Chuẩn",
    noSnapshot: "Không có snapshot chuẩn",
    summary: "Tóm tắt tháng",
    stockNetChange: "Chênh lệch kho",
    purchaseQuantity: "SL nhập mua",
    purchaseAmountKnown: "Tiền nhập mua",
    purchaseAmountMissing: "Thiếu đơn giá",
    stockCheckNetChange: "Kiểm kho",
    serviceNetChange: "DV/tặng",
    otherNetChange: "Khác",
    unclassifiedLogCount: "Chưa phân loại",
    dailyFlow: "Theo ngày",
    noMovements: "Không có biến động trong tháng này.",
    itemSummary: "Tóm tắt theo mặt hàng",
    noItems: "Không có mặt hàng để hiển thị.",
    supplier: "Nơi mua",
    purchase: "Nhập",
    amount: "Thành tiền",
    unitPrice: "Đơn giá",
    priceNotSet: "Chưa có đơn giá",
    existing: "Có sẵn",
    new: "Mới",
    missing: "Thiếu",
    guide:
      "Chênh lệch kho là khác biệt giữa snapshot chuẩn và snapshot mới nhất; nhập/kiểm kho/dịch vụ/khác hiển thị theo số liệu API đã tổng hợp.",
  },
} as const;

const getVietnamMonth = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  return `${year}-${month}`;
};

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
});

const moneyFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const formatQuantity = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "-";
  return numberFormatter.format(value);
};

const formatSignedQuantity = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "-";
  return `${value > 0 ? "+" : ""}${formatQuantity(value)}`;
};

const formatMoney = (value: number | null | undefined, emptyText: string) => {
  if (value === null || value === undefined) return emptyText;
  return `${moneyFormatter.format(value)} VND`;
};

const formatShortDate = (value: string) => {
  const [, month, day] = value.split("-");
  return month && day ? `${month}/${day}` : value;
};

const getSignedColor = (value: number) => {
  if (value > 0) return "seagreen";
  if (value < 0) return "crimson";
  return "#374151";
};

const getStatusColor = (status: MonthlyItemStatus) => {
  if (status === "new") return "seagreen";
  if (status === "missing") return "crimson";
  return "#4b5563";
};

const getStatusLabel = (
  status: MonthlyItemStatus,
  labels: (typeof monthlyText)["ko"] | (typeof monthlyText)["vi"]
) => {
  if (status === "new") return labels.new;
  if (status === "missing") return labels.missing;
  return labels.existing;
};

export default function InventoryMonthlyPage() {
  const { lang } = useLanguage();
  const c = commonText[lang];
  const labels = monthlyText[lang];
  const pathname = usePathname();
  const inventoryTabs = getInventoryTabs(pathname, lang);

  const [selectedMonth, setSelectedMonth] = useState(getVietnamMonth);
  const [data, setData] = useState<MonthlyInventoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let ignore = false;

    const fetchMonthly = async () => {
      setLoading(true);
      setError("");

      try {
        const res = await fetch(`/api/inventory/monthly?month=${selectedMonth}`, {
          cache: "no-store",
        });
        const json = (await res.json()) as MonthlyInventoryResponse | ErrorResponse;

        if (!res.ok || !json.ok) {
          if (!ignore) {
            setData(null);
            setError("message" in json && json.message ? json.message : c.loadFailed);
          }
          return;
        }

        if (!ignore) {
          setData(json);
        }
      } catch (fetchError) {
        console.error(fetchError);
        if (!ignore) {
          setData(null);
          setError(c.loadFailed);
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    };

    fetchMonthly();

    return () => {
      ignore = true;
    };
  }, [selectedMonth, refreshToken, c.loadFailed]);

  const summaryCards = useMemo(() => {
    if (!data) return [];

    return [
      {
        label: labels.stockNetChange,
        value: formatSignedQuantity(data.summary.stockNetChange),
        color: getSignedColor(data.summary.stockNetChange),
      },
      {
        label: labels.purchaseQuantity,
        value: formatQuantity(data.summary.purchaseQuantity),
        color: "seagreen",
      },
      {
        label: labels.purchaseAmountKnown,
        value: formatMoney(data.summary.purchaseAmountKnown, labels.priceNotSet),
        color: "#111827",
      },
      {
        label: labels.purchaseAmountMissing,
        value: formatQuantity(data.summary.purchaseAmountMissingCount),
        color: data.summary.purchaseAmountMissingCount > 0 ? "crimson" : "#111827",
      },
      {
        label: labels.stockCheckNetChange,
        value: formatSignedQuantity(data.summary.stockCheckNetChange),
        color: getSignedColor(data.summary.stockCheckNetChange),
      },
      {
        label: labels.serviceNetChange,
        value: formatSignedQuantity(data.summary.serviceNetChange),
        color: getSignedColor(data.summary.serviceNetChange),
      },
      {
        label: labels.otherNetChange,
        value: formatSignedQuantity(data.summary.otherNetChange),
        color: getSignedColor(data.summary.otherNetChange),
      },
      {
        label: labels.unclassifiedLogCount,
        value: formatQuantity(data.summary.unclassifiedLogCount),
        color: data.summary.unclassifiedLogCount > 0 ? "crimson" : "#111827",
      },
    ];
  }, [data, labels]);

  return (
    <Container noPaddingTop>
      <SubNav tabs={inventoryTabs} />

      <div style={{ marginBottom: 10 }}>
        <div style={{ ...ui.metaText, fontWeight: 800 }}>
          {lang === "ko" ? labels.titleVi : labels.titleVi}
        </div>
        <h1
          style={{
            fontSize: 20,
            fontWeight: 800,
            color: "#111827",
            margin: "2px 0 0",
          }}
        >
          {labels.title}
        </h1>
      </div>

      <div
        style={{
          ...ui.card,
          padding: 12,
          marginBottom: 12,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          gap: 8,
          alignItems: "end",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <span style={{ ...ui.metaText, fontWeight: 800 }}>{labels.month}</span>
          <input
            type="month"
            value={selectedMonth}
            onChange={(event) => setSelectedMonth(event.target.value)}
            style={{ ...ui.input, height: 42, padding: "8px 12px" }}
          />
        </label>
        <button
          type="button"
          onClick={() => setRefreshToken((value) => value + 1)}
          disabled={loading}
          style={{
            ...ui.subButton,
            width: "auto",
            minWidth: 78,
            height: 42,
            padding: "0 12px",
            fontSize: 13,
            opacity: loading ? 0.6 : 1,
          }}
        >
          {labels.refresh}
        </button>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 12px",
            borderRadius: 10,
            background: "#fff5f5",
            border: "1px solid #f3caca",
            color: "crimson",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          {error}
        </div>
      )}

      {loading && !data ? (
        <div
          style={{
            ...ui.card,
            padding: 24,
            marginBottom: 12,
            textAlign: "center",
            color: "#6b7280",
            fontSize: 13,
          }}
        >
          {c.loading}
        </div>
      ) : data ? (
        <>
          <div
            style={{
              marginBottom: 12,
              padding: "8px 10px",
              borderRadius: 10,
              background:
                data.baseline.snapshotDate && data.latest.snapshotDate
                  ? "#f9fafb"
                  : "#fffbeb",
              border:
                data.baseline.snapshotDate && data.latest.snapshotDate
                  ? "1px solid #e5e7eb"
                  : "1px solid #fde68a",
              fontSize: 12,
              color: "#6b7280",
              fontWeight: 700,
            }}
          >
            {labels.baseRange}:{" "}
            <span style={{ color: "#111827" }}>
              {data.baseline.snapshotDate || labels.noSnapshot} →{" "}
              {data.latest.snapshotDate || labels.noSnapshot}
            </span>
          </div>

          <section style={{ ...ui.card, padding: 12, marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 10,
                gap: 8,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
                {labels.summary}
              </span>
              <span style={{ ...ui.metaText, fontWeight: 800 }}>
                {data.range.fromDate} - {data.range.toDate}
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 8,
              }}
            >
              {summaryCards.map((item) => (
                <div
                  key={item.label}
                  style={{
                    border: "1px solid #e5e7eb",
                    borderRadius: 10,
                    padding: "8px 10px",
                    background: "#fff",
                    minWidth: 0,
                  }}
                >
                  <div style={{ ...ui.metaText, fontWeight: 800 }}>{item.label}</div>
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 15,
                      fontWeight: 900,
                      color: item.color,
                      lineHeight: 1.2,
                      wordBreak: "break-word",
                    }}
                  >
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={{ ...ui.card, padding: 12, marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
                gap: 8,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
                {labels.dailyFlow}
              </span>
              <span style={{ ...ui.metaText, fontWeight: 800 }}>
                {data.days.length}
              </span>
            </div>

            {data.days.length === 0 ? (
              <div style={{ ...ui.metaText, padding: "8px 2px" }}>
                {labels.noMovements}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {data.days.map((day) => (
                  <div
                    key={day.businessDate}
                    style={{
                      ...ui.card,
                      boxShadow: "none",
                      borderRadius: 10,
                      padding: "8px 10px",
                      background: "#fff",
                    }}
                  >
                    <div style={ui.cardRow}>
                      <div style={{ fontSize: 14, fontWeight: 900, color: "#111827" }}>
                        {formatShortDate(day.businessDate)}
                      </div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 900,
                          color: getSignedColor(day.totalLogNetChange),
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatSignedQuantity(day.totalLogNetChange)}
                      </div>
                    </div>
                    <div style={{ ...ui.metaText, marginTop: 4 }}>
                      {labels.purchase} +{formatQuantity(day.purchaseQuantity)} ·{" "}
                      {labels.stockCheckNetChange}{" "}
                      {formatSignedQuantity(day.stockCheckNetChange)} ·{" "}
                      {labels.serviceNetChange}{" "}
                      {formatSignedQuantity(day.serviceNetChange)} · {labels.otherNetChange}{" "}
                      {formatSignedQuantity(day.otherNetChange)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section style={{ ...ui.card, padding: 12, marginBottom: 12 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 10,
                gap: 8,
              }}
            >
              <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
                {labels.itemSummary}
              </span>
              <span style={{ ...ui.metaText, fontWeight: 800 }}>
                {data.items.length}
              </span>
            </div>

            {data.items.length === 0 ? (
              <div style={{ ...ui.metaText, padding: "8px 2px" }}>{labels.noItems}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {data.items.map((item) => {
                  const displayName =
                    lang === "vi" ? item.nameVi || item.name : item.name || item.nameVi || "-";
                  const displayCategory =
                    lang === "vi"
                      ? item.categoryVi || item.category || "-"
                      : item.category || item.categoryVi || "-";

                  return (
                    <div
                      key={item.itemId}
                      style={{
                        ...ui.card,
                        boxShadow: "none",
                        borderLeft: `4px solid ${getStatusColor(item.status)}`,
                        borderRadius: 10,
                        padding: "8px 10px",
                        background: "#fff",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "flex-start",
                          gap: 10,
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                fontSize: 14,
                                fontWeight: 900,
                                color: "#111827",
                                wordBreak: "break-word",
                              }}
                            >
                              {[item.code ? `[${item.code}]` : "", displayName]
                                .filter(Boolean)
                                .join(" ")}
                            </span>
                            <span
                              style={{
                                ...ui.badgeMini,
                                background: getStatusColor(item.status),
                              }}
                            >
                              {getStatusLabel(item.status, labels)}
                            </span>
                          </div>
                          <div style={{ ...ui.metaText, marginTop: 2 }}>
                            {[
                              displayCategory,
                              item.supplier ? `${labels.supplier}: ${item.supplier}` : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </div>

                        <div
                          style={{
                            flexShrink: 0,
                            textAlign: "right",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 15,
                              fontWeight: 900,
                              color: getSignedColor(item.stockNetChange),
                            }}
                          >
                            {formatSignedQuantity(item.stockNetChange)}
                          </div>
                          <div style={ui.metaText}>
                            {formatQuantity(item.baselineQuantity)} →{" "}
                            {formatQuantity(item.latestQuantity)} {item.unit || ""}
                          </div>
                        </div>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                          gap: "4px 10px",
                          marginTop: 7,
                        }}
                      >
                        <div style={ui.metaText}>
                          {labels.purchase}:{" "}
                          <b style={{ color: "seagreen" }}>
                            {formatQuantity(item.purchaseQuantity)}
                          </b>
                        </div>
                        <div style={ui.metaText}>
                          {labels.amount}:{" "}
                          <b>{formatMoney(item.purchaseAmount, labels.priceNotSet)}</b>
                        </div>
                        <div style={ui.metaText}>
                          {labels.unitPrice}:{" "}
                          <b>{formatMoney(item.purchasePriceUsed, labels.priceNotSet)}</b>
                        </div>
                        <div style={ui.metaText}>
                          {labels.stockCheckNetChange}:{" "}
                          <b>{formatSignedQuantity(item.stockCheckNetChange)}</b>
                        </div>
                      </div>

                      <div style={{ ...ui.metaText, marginTop: 5 }}>
                        {labels.serviceNetChange}{" "}
                        <b>{formatSignedQuantity(item.serviceNetChange)}</b> ·{" "}
                        {labels.otherNetChange}{" "}
                        <b>{formatSignedQuantity(item.otherNetChange)}</b>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div style={{ ...ui.metaText, marginBottom: 16 }}>{labels.guide}</div>
        </>
      ) : null}
    </Container>
  );
}
