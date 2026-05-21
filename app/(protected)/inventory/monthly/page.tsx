"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { ui } from "@/lib/styles/ui";
import { useLanguage } from "@/lib/language-context";
import { commonText } from "@/lib/text";
import { getInventoryTabs } from "@/lib/navigation/inventory-tabs";
import { INVENTORY_REASON_EMOJIS } from "@/lib/inventory/reasons";

type MonthlyItemStatus = "existing" | "new" | "missing";
type LatestSource = "snapshot" | "current_inventory" | null;

type MonthlyItem = {
  itemId: number;
  code: string | null;
  name: string;
  nameVi: string | null;
  unit: string | null;
  supplier: string | null;
  supplierLabel: string;
  part: string | null;
  category: string | null;
  categoryVi: string | null;
  baselineQuantity: number | null;
  latestQuantity: number | null;
  stockNetChange: number;
  baselinePurchasePrice: number | null;
  latestPurchasePrice: number | null;
  registeredPrice: number | null;
  purchasePriceUsed: number | null;
  purchasePriceDiff: number | null;
  priceChangedDate: string | null;
  priceChangeEvents: PriceChangeEvent[];
  purchaseQuantity: number;
  purchaseLogCount: number;
  purchaseAmount: number | null;
  purchaseAmountMissing?: boolean;
  stockCheckNetChange: number;
  serviceNetChange: number;
  otherNetChange: number;
  totalLogNetChange: number;
  status: MonthlyItemStatus;
};

type PriceChangeEvent = {
  businessDate: string;
  previousPrice: number | null;
  newPrice: number;
  diff: number | null;
  source: string;
  reason: string | null;
  purchaseQuantity?: number | null;
};

type SupplierSummary = {
  supplier: string | null;
  supplierLabel: string;
  itemCount: number;
  purchaseQuantity: number;
  purchaseAmountKnown: number;
  purchaseAmountMissingCount: number;
  stockNetChange: number;
  stockCheckNetChange: number;
  serviceNetChange: number;
  otherNetChange: number;
  totalLogNetChange: number;
};

type SupplierGroup = {
  key: string;
  supplier: string | null;
  supplierLabel: string;
  summary: SupplierSummary | null;
  items: MonthlyItem[];
};

type CategoryGroup = {
  key: string;
  label: string;
  items: MonthlyItem[];
};

type MovementSignal = {
  key: string;
  emoji: string;
  label: string;
  value: string;
  valueColor: string;
};

type DetailRow = {
  label: string;
  value: string;
  color?: string;
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
    source: LatestSource;
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
  supplierSummary: SupplierSummary[];
  items: MonthlyItem[];
};

type ErrorResponse = {
  ok: false;
  message?: string;
};

const monthlyText = {
  ko: {
    month: "월 선택",
    searchPlaceholder: "품목명 / 베트남명 / 코드 / 거래처 검색",
    refresh: "새로고침",
    all: "전체",
    unregisteredSupplier: "거래처 미등록",
    statusAll: "전체",
    statusPurchase: "입고 있음",
    statusStockUp: "재고 증가",
    statusStockDown: "재고 감소",
    statusService: "서비스 있음",
    statusMissingPrice: "단가 누락",
    statusNew: "신규",
    statusMissing: "누락/삭제 가능",
    summary: "월간 요약",
    stockNetChange: "재고 순변동",
    purchaseAmountKnown: "입고금액",
    purchaseAmountHint: "단가 등록 항목 기준",
    purchaseQuantity: "입고수량",
    purchaseItemCount: "입고품목",
    purchaseLogCount: "입고로그",
    stockChangedItemCount: "재고변동 품목",
    purchaseAmountMissing: "단가누락",
    priceChanged: "단가변경",
    stockCheckNetChange: "재고확인",
    stockCheckShort: "확인",
    serviceNetChange: "서비스/증정",
    serviceShort: "서비스",
    otherNetChange: "기타",
    previousMonthChange: "전월대비",
    itemCountUnit: "품목",
    logCountUnit: "건",
    baseRange: "기준",
    noSnapshot: "스냅샷 없음",
    currentInventory: "현재 재고 기준",
    notClosingSnapshot: "마감 스냅샷 아님",
    snapshotSource: "스냅샷 기준",
    supplierSummary: "거래처별 요약",
    itemSummary: "품목별 월간요약",
    noData: "표시할 데이터가 없습니다.",
    noSearchResults: "검색 결과가 없습니다.",
    noSupplierSummary: "거래처별 요약이 없습니다.",
    supplier: "거래처",
    category: "카테고리",
    uncategorized: "미분류",
    quantitySection: "수량 기준",
    purchaseSection: "입고/금액",
    priceSection: "단가",
    priceChangeHistory: "단가 변경 내역",
    movementSection: "기타 변동",
    infoSection: "정보",
    baselineShort: "전월 기준",
    latestShort: "현재 수량",
    currentUnitPrice: "현재 단가",
    priceChangedDate: "변경일",
    priceChangedDateUnknown: "입고로그 없음",
    times: "회",
    unit: "단위",
    baselineQuantity: "기준 수량",
    latestQuantity: "현재 수량",
    purchase: "입고",
    amount: "금액",
    unitPrice: "기준 단가",
    priceNotSet: "단가 미등록",
    priceChange: "단가 변동",
    status: "상태",
    existing: "기존",
    new: "신규",
    missing: "누락/삭제 가능",
  },
  vi: {
    month: "Thang",
    searchPlaceholder: "Tim ten hang / ten Viet / ma / noi mua",
    refresh: "Tai lai",
    all: "Tat ca",
    unregisteredSupplier: "Chua co noi mua",
    statusAll: "Tat ca",
    statusPurchase: "Co nhap",
    statusStockUp: "Kho tang",
    statusStockDown: "Kho giam",
    statusService: "Co tang/service",
    statusMissingPrice: "Thieu don gia",
    statusNew: "Moi",
    statusMissing: "Co the thieu/xoa",
    summary: "Tom tat thang",
    stockNetChange: "Chenh lech kho",
    purchaseAmountKnown: "Tien nhap",
    purchaseAmountHint: "Theo mat hang co don gia",
    purchaseQuantity: "SL nhap",
    purchaseItemCount: "Mat hang nhap",
    purchaseLogCount: "Luot nhap",
    stockChangedItemCount: "Mat hang doi kho",
    purchaseAmountMissing: "Thieu gia",
    priceChanged: "Doi gia",
    stockCheckNetChange: "Kiem kho",
    stockCheckShort: "Kiem",
    serviceNetChange: "Tang/Service",
    serviceShort: "Service",
    otherNetChange: "Khac",
    previousMonthChange: "So thang truoc",
    itemCountUnit: "mat hang",
    logCountUnit: "luot",
    baseRange: "Chuan",
    noSnapshot: "Khong co snapshot",
    currentInventory: "Theo kho hien tai",
    notClosingSnapshot: "Khong phai snapshot chot",
    snapshotSource: "Theo snapshot",
    supplierSummary: "Tom tat theo noi mua",
    itemSummary: "Tom tat theo mat hang",
    noData: "Khong co du lieu hien thi.",
    noSearchResults: "Khong co ket qua tim kiem.",
    noSupplierSummary: "Khong co tom tat theo noi mua.",
    supplier: "Noi mua",
    category: "Danh muc",
    uncategorized: "Chua phan loai",
    quantitySection: "So luong",
    purchaseSection: "Nhap/Tien",
    priceSection: "Don gia",
    priceChangeHistory: "Lich su doi gia",
    movementSection: "Bien dong khac",
    infoSection: "Thong tin",
    baselineShort: "Thang truoc",
    latestShort: "Hien tai",
    currentUnitPrice: "Don gia hien tai",
    priceChangedDate: "Ngay doi",
    priceChangedDateUnknown: "Khong co log nhap",
    times: "lan",
    unit: "Don vi",
    baselineQuantity: "SL chuan",
    latestQuantity: "SL hien tai",
    purchase: "Nhap",
    amount: "Tien",
    unitPrice: "Don gia chuan",
    priceNotSet: "Chua co don gia",
    priceChange: "Doi gia",
    status: "Trang thai",
    existing: "Co san",
    new: "Moi",
    missing: "Co the thieu/xoa",
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

const SEP = " \u00B7 ";

const MONTHLY_SIGNAL_EMOJIS = {
  missingPrice: "\u26A0\uFE0F",
  priceChange: "\u{1F4B8}",
} as const;

const isMojibakeText = (value: string) =>
  /[?\uFFFD\uCA0C\uCAD9\uC7A1\uAF43]/.test(value);

const getSafeEmoji = (value: string, fallback: string) =>
  value && !isMojibakeText(value) ? value : fallback;

const MONTHLY_REASON_EMOJIS = {
  purchase: getSafeEmoji(INVENTORY_REASON_EMOJIS.purchase, "\u{1F6D2}"),
  stock_check: getSafeEmoji(INVENTORY_REASON_EMOJIS.stock_check, "\u2705"),
  service: getSafeEmoji(INVENTORY_REASON_EMOJIS.service, "\u{1F381}"),
  other: getSafeEmoji(INVENTORY_REASON_EMOJIS.other, "\u{1F4DD}"),
} as const;

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      style={{
        display: "block",
        transform: open ? "rotate(180deg)" : "rotate(0deg)",
        transition: "transform 0.15s ease",
      }}
    >
      <path
        d="M5 7.5L10 12.5L15 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const formatQuantity = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "-";
  return numberFormatter.format(value);
};

const formatSignedQuantity = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "-";
  return `${value > 0 ? "+" : ""}${formatQuantity(value)}`;
};

const formatQuantityWithUnit = (value: number | null | undefined, unit?: string | null) => {
  const quantity = formatQuantity(value);
  return unit ? `${quantity} ${unit}` : quantity;
};

const formatSignedQuantityWithUnit = (
  value: number | null | undefined,
  unit?: string | null
) => {
  const quantity = formatSignedQuantity(value);
  return unit ? `${quantity} ${unit}` : quantity;
};

const formatMoney = (value: number | null | undefined, emptyText: string) => {
  if (value === null || value === undefined) return emptyText;
  return `${moneyFormatter.format(value)} VND`;
};

const formatSignedMoney = (value: number | null | undefined, emptyText: string) => {
  if (value === null || value === undefined) return emptyText;
  return `${value > 0 ? "+" : ""}${moneyFormatter.format(value)} VND`;
};

const formatShortDate = (value: string | null | undefined, emptyText: string) => {
  if (!value) return emptyText;
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

const getSupplierKey = (supplier?: string | null) => supplier?.trim() || "__none__";

const sortText = (value: string | null | undefined) => value?.trim().toLocaleLowerCase() || "";

const hasMissingPurchasePrice = (item: MonthlyItem) =>
  item.purchaseAmountMissing ?? (item.purchaseQuantity > 0 && item.purchaseAmount === null);

const hasPurchasePriceChange = (item: MonthlyItem) =>
  item.priceChangeEvents.length > 0 ||
  (item.purchasePriceDiff !== null && item.purchasePriceDiff !== 0);

const getPriceChangeLabel = (event: PriceChangeEvent, lang: "ko" | "vi") => {
  const key = event.reason || event.source;

  if (lang === "vi") {
    if (key === "purchase") return "Nhap mua";
    if (key === "manual_price_update") return "Chinh sua";
    if (key === "create") return "Tao moi";
    return "He thong";
  }

  if (key === "purchase") return "\uAD6C\uB9E4\uC785\uACE0";
  if (key === "manual_price_update") return "\uC218\uC815";
  if (key === "create") return "\uCD5C\uCD08\uB4F1\uB85D";
  return "\uC2DC\uC2A4\uD15C";
};

const getDetailLabels = (lang: "ko" | "vi") => {
  if (lang === "vi") {
    return {
      registeredPrice: "Gi\u00E1 g\u1ED1c",
      currentUnitPrice: "Gi\u00E1 hi\u1EC7n t\u1EA1i",
      priceChange: "Ch\u00EAnh gi\u00E1",
      priceChangeHistory: "L\u1ECBch s\u1EED gi\u00E1",
      baselineShort: "Tr\u01B0\u1EDBc",
      latestShort: "Hi\u1EC7n t\u1EA1i",
      previousMonthChange: "Ch\u00EAnh",
      purchaseQuantity: "Nh\u1EADp",
      purchaseAmountKnown: "Ti\u1EC1n nh\u1EADp",
      movementSection: "Bi\u1EBFn \u0111\u1ED9ng",
      stockCheckNetChange: "Ki\u1EC3m kho",
    };
  }

  return {
    registeredPrice: "\uB4F1\uB85D \uB2E8\uAC00",
    currentUnitPrice: "\uD604\uC7AC \uB2E8\uAC00",
    priceChange: "\uB2E8\uAC00 \uBCC0\uB3D9",
    priceChangeHistory: "\uB2E8\uAC00 \uBCC0\uACBD \uB0B4\uC5ED",
    baselineShort: "\uC804\uC6D4 \uAE30\uC900",
    latestShort: "\uD604\uC7AC \uC218\uB7C9",
    previousMonthChange: "\uC804\uC6D4\uB300\uBE44",
    purchaseQuantity: "\uC785\uACE0\uC218\uB7C9",
    purchaseAmountKnown: "\uC785\uACE0\uAE08\uC561",
    movementSection: "\uAE30\uD0C0 \uBCC0\uB3D9",
    stockCheckNetChange: "\uC7AC\uACE0\uD655\uC778",
  };
};

export default function InventoryMonthlyPage() {
  const { lang } = useLanguage();
  const c = commonText[lang];
  const labels = monthlyText[lang];
  const detailLabels = getDetailLabels(lang);
  const pathname = usePathname();
  const inventoryTabs = getInventoryTabs(pathname, lang);

  const [selectedMonth, setSelectedMonth] = useState(getVietnamMonth);
  const [data, setData] = useState<MonthlyInventoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expandedSupplierKeys, setExpandedSupplierKeys] = useState<Record<string, boolean>>({});
  const [expandedItemIds, setExpandedItemIds] = useState<Record<number, boolean>>({});

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
          setExpandedSupplierKeys({});
          setExpandedItemIds({});
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
  }, [selectedMonth, c.loadFailed]);

  const supplierGroups = useMemo<SupplierGroup[]>(() => {
    if (!data) return [];

    const map = new Map<string, SupplierGroup>();

    for (const supplier of data.supplierSummary) {
      const key = getSupplierKey(supplier.supplier);
      map.set(key, {
        key,
        supplier: supplier.supplier,
        supplierLabel: supplier.supplierLabel || labels.unregisteredSupplier,
        summary: supplier,
        items: [],
      });
    }

    for (const item of data.items) {
      const key = getSupplierKey(item.supplier);
      const existing =
        map.get(key) ??
        ({
          key,
          supplier: item.supplier,
          supplierLabel: item.supplierLabel || labels.unregisteredSupplier,
          summary: null,
          items: [],
        } satisfies SupplierGroup);

      existing.items.push(item);
      map.set(key, existing);
    }

    return [...map.values()]
      .map((group) => ({
        ...group,
        items: [...group.items].sort((a, b) => {
          const aCode = sortText(a.code);
          const bCode = sortText(b.code);
          if (aCode && !bCode) return -1;
          if (!aCode && bCode) return 1;
          const codeCompare = sortText(a.code).localeCompare(sortText(b.code));
          if (codeCompare !== 0) return codeCompare;
          return sortText(a.name || a.nameVi).localeCompare(sortText(b.name || b.nameVi));
        }),
      }))
      .sort((a, b) => {
        if (a.key === "__none__") return 1;
        if (b.key === "__none__") return -1;
        return sortText(a.supplierLabel).localeCompare(sortText(b.supplierLabel));
      });
  }, [data, labels.unregisteredSupplier]);

  const getDisplayName = (item: MonthlyItem) =>
    lang === "vi" ? item.nameVi || item.name : item.name || item.nameVi || "-";

  const getCategoryLabel = (item: MonthlyItem) =>
    lang === "vi" ? item.categoryVi || item.category : item.category || item.categoryVi;

  const getCategoryGroups = (items: MonthlyItem[]) => {
    const map = new Map<string, CategoryGroup>();

    for (const item of items) {
      const key = item.category || item.categoryVi || "__none__";
      const label = getCategoryLabel(item) || labels.uncategorized;
      const existing =
        map.get(key) ??
        ({
          key,
          label,
          items: [],
        } satisfies CategoryGroup);

      existing.items.push(item);
      map.set(key, existing);
    }

    return [...map.values()];
  };

  const serviceChangedItemCount =
    data?.items.filter((item) => item.serviceNetChange !== 0).length ?? 0;
  const stockCheckChangedItemCount =
    data?.items.filter((item) => item.stockCheckNetChange !== 0).length ?? 0;
  const otherChangedItemCount =
    data?.items.filter((item) => item.otherNetChange !== 0).length ?? 0;
  const missingPriceItemCount =
    data?.summary.purchaseAmountMissingCount ??
    data?.items.filter(hasMissingPurchasePrice).length ??
    0;
  const priceChangedItemCount = data?.items.filter(hasPurchasePriceChange).length ?? 0;

  const getItemAmountText = (item: MonthlyItem) => {
    if (item.purchaseAmount !== null) return formatMoney(item.purchaseAmount, labels.priceNotSet);
    if (item.purchaseQuantity > 0) return `${MONTHLY_SIGNAL_EMOJIS.missingPrice} ${labels.priceNotSet}`;
    return "";
  };

  return (
    <Container noPaddingTop>
      <SubNav tabs={inventoryTabs} />

      <div
        style={{
          ...ui.card,
          padding: 12,
          marginBottom: 12,
        }}
      >
        <input
          type="month"
          value={selectedMonth}
          aria-label={labels.month}
          onChange={(event) => setSelectedMonth(event.target.value)}
          style={{ ...ui.input, height: 40, padding: "8px 12px", minWidth: 0 }}
        />
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
          <section style={{ ...ui.card, padding: 12, marginBottom: 16 }}>
            <div style={{ ...ui.cardRow, marginBottom: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
                {labels.summary}
              </span>
              <span style={{ ...ui.metaText, fontWeight: 800 }}>
                {formatShortDate(data.range.fromDate, "")} -{" "}
                {formatShortDate(data.range.toDate, "")}
              </span>
            </div>

            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 10,
                padding: "9px 10px",
                background: "#fff",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ ...ui.metaText, fontWeight: 900 }}>
                {MONTHLY_REASON_EMOJIS.purchase} {labels.purchaseAmountKnown}
              </span>
              <span
                style={{
                  minWidth: 0,
                  fontSize: 17,
                  fontWeight: 900,
                  color: "#111827",
                  lineHeight: 1.2,
                  textAlign: "right",
                  wordBreak: "break-word",
                }}
              >
                {formatMoney(data.summary.purchaseAmountKnown, labels.priceNotSet)}
              </span>
            </div>

            <div
              style={{
                marginTop: 8,
                padding: "7px 10px",
                borderRadius: 8,
                background: "#f9fafb",
                border: "1px solid #e5e7eb",
                display: "flex",
                flexDirection: "column",
                gap: 4,
                fontSize: 12,
                fontWeight: 800,
                color: "#374151",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
                <span>
                  {MONTHLY_REASON_EMOJIS.purchase} {labels.purchase}{" "}
                  <b>{formatQuantity(data.summary.purchaseItemCount)}</b>
                </span>
                <span>{SEP.trim()}</span>
                <span>
                  {MONTHLY_SIGNAL_EMOJIS.missingPrice} {labels.purchaseAmountMissing}{" "}
                  <b>{formatQuantity(missingPriceItemCount)}</b>
                </span>
                <span>{SEP.trim()}</span>
                <span>
                  {MONTHLY_SIGNAL_EMOJIS.priceChange && (
                    <>{MONTHLY_SIGNAL_EMOJIS.priceChange} </>
                  )}
                  {labels.priceChanged} <b>{formatQuantity(priceChangedItemCount)}</b>
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 8px" }}>
                <span>
                  {MONTHLY_REASON_EMOJIS.stock_check} {labels.stockCheckShort}{" "}
                  <b>{formatQuantity(stockCheckChangedItemCount)}</b>
                </span>
                <span>{SEP.trim()}</span>
                <span>
                  {MONTHLY_REASON_EMOJIS.service} {labels.serviceShort}{" "}
                  <b>{formatQuantity(serviceChangedItemCount)}</b>
                </span>
                <span>{SEP.trim()}</span>
                <span>
                  {MONTHLY_REASON_EMOJIS.other} {labels.otherNetChange}{" "}
                  <b>{formatQuantity(otherChangedItemCount)}</b>
                </span>
              </div>
            </div>
          </section>

          <section style={{ ...ui.card, padding: 12, marginBottom: 12 }}>
            <div style={{ ...ui.cardRow, marginBottom: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
                {labels.supplierSummary}
              </span>
              <span style={{ ...ui.metaText, fontWeight: 800 }}>
                {supplierGroups.length}
              </span>
            </div>

            {supplierGroups.length === 0 ? (
              <div style={{ ...ui.metaText, padding: "8px 2px" }}>
                {data.items.length === 0 ? labels.noData : labels.noSupplierSummary}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {supplierGroups.map((group) => {
                  const expandedSupplier = Boolean(expandedSupplierKeys[group.key]);
                  const supplier = group.summary;
                  const itemCount = supplier?.itemCount ?? group.items.length;
                  const supplierMissingPriceCount = group.items.filter(
                    hasMissingPurchasePrice
                  ).length;
                  const supplierPriceChangedCount = group.items.filter(
                    hasPurchasePriceChange
                  ).length;
                  const supplierServiceCount = group.items.filter(
                    (item) => item.serviceNetChange !== 0
                  ).length;
                  const supplierSignals = [
                    supplierMissingPriceCount > 0
                      ? `${MONTHLY_SIGNAL_EMOJIS.missingPrice} ${formatQuantity(supplierMissingPriceCount)}`
                      : "",
                    supplierPriceChangedCount > 0
                      ? `${MONTHLY_SIGNAL_EMOJIS.priceChange} ${formatQuantity(supplierPriceChangedCount)}`
                      : "",
                    supplierServiceCount > 0
                      ? `${MONTHLY_REASON_EMOJIS.service} ${formatQuantity(
                          supplierServiceCount
                        )}`
                      : "",
                  ].filter(Boolean);

                  return (
                    <div
                      key={group.key}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 10,
                        background: "#fff",
                        overflow: "hidden",
                      }}
                    >
	                      <button
	                        type="button"
	                        aria-expanded={expandedSupplier}
	                        onClick={() =>
	                          setExpandedSupplierKeys((prev) => ({
                            ...prev,
                            [group.key]: !prev[group.key],
                          }))
                        }
                        style={{
                          width: "100%",
                          border: "none",
                          background: "transparent",
                          padding: "8px 10px",
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) auto auto",
                          gap: 8,
                          alignItems: "center",
                          textAlign: "left",
                          cursor: "pointer",
                        }}
                      >
                        <span
                          style={{
                            minWidth: 0,
                            display: "flex",
                            alignItems: "baseline",
                            gap: 5,
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span
                            style={{
                              minWidth: 0,
                              fontSize: 14,
                              fontWeight: 900,
                              color: "#111827",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {group.supplierLabel || labels.unregisteredSupplier}
                          </span>
                          <span style={{ ...ui.metaText, flexShrink: 0 }}>
                            {SEP.trim()} {formatQuantity(itemCount)}
                          </span>
                        </span>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 900,
                            color: "#111827",
                            whiteSpace: "nowrap",
                            textAlign: "right",
                          }}
                        >
                          {supplier
                            ? formatMoney(supplier.purchaseAmountKnown, labels.priceNotSet)
                            : "-"}
                        </span>
	                        <span
	                          style={{
	                            color: "#6b7280",
	                            display: "flex",
	                            alignItems: "center",
	                            justifyContent: "center",
	                            width: 18,
	                            height: 18,
	                            lineHeight: 1,
	                          }}
	                        >
	                          <ChevronIcon open={expandedSupplier} />
	                        </span>
                      </button>

                      {supplierSignals.length > 0 && (
                        <div
                          style={{
                            padding: "0 10px 8px",
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "2px 7px",
                            color: "#6b7280",
                            fontSize: 12,
                            fontWeight: 800,
                          }}
                        >
                          {supplierSignals.map((signal, index) => (
                            <span key={signal}>
                              {index > 0 ? SEP : ""}
                              {signal}
                            </span>
                          ))}
                        </div>
                      )}

                      {expandedSupplier && (
                        <div
                          style={{
                            borderTop: "1px solid #f1f5f9",
                            padding: "7px 8px 8px",
                            display: "flex",
                            flexDirection: "column",
                            gap: 7,
                          }}
                        >
                          {group.items.length === 0 ? (
                            <div style={{ ...ui.metaText, padding: "2px 2px" }}>
                              {labels.noData}
                            </div>
                          ) : (
                            getCategoryGroups(group.items).map((categoryGroup) => (
                              <div
                                key={categoryGroup.key}
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 6,
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 900,
                                    color: "#374151",
                                    padding: "2px 2px 0",
                                  }}
                                >
                                  {categoryGroup.label}
                                </div>

                                {categoryGroup.items.map((item) => {
                              const expanded = Boolean(expandedItemIds[item.itemId]);
                              const displayName = getDisplayName(item);
                              const itemAmountText = getItemAmountText(item);
                              const movementSignalCandidates: Array<MovementSignal | null> = [
                                item.stockCheckNetChange !== 0
                                  ? {
                                      key: "stock_check",
                                      emoji: MONTHLY_REASON_EMOJIS.stock_check,
                                      label: labels.stockCheckShort,
                                      value: formatSignedQuantity(item.stockCheckNetChange),
                                      valueColor: getSignedColor(item.stockCheckNetChange),
                                    }
                                  : null,
                                item.serviceNetChange !== 0
                                  ? {
                                      key: "service",
                                      emoji: MONTHLY_REASON_EMOJIS.service,
                                      label: labels.serviceShort,
                                      value: formatSignedQuantity(item.serviceNetChange),
                                      valueColor: getSignedColor(item.serviceNetChange),
                                    }
                                  : null,
                                item.otherNetChange !== 0
                                  ? {
                                      key: "other",
                                      emoji: MONTHLY_REASON_EMOJIS.other,
                                      label: labels.otherNetChange,
                                      value: formatSignedQuantity(item.otherNetChange),
                                      valueColor: getSignedColor(item.otherNetChange),
                                    }
                                  : null,
                                hasPurchasePriceChange(item)
                                  ? {
                                      key: "price",
                                      emoji: MONTHLY_SIGNAL_EMOJIS.priceChange,
                                      label: labels.priceChanged,
                                      value:
                                        item.priceChangeEvents.length > 0
                                          ? `${formatQuantity(
                                              item.priceChangeEvents.length
                                            )}${labels.times}`
                                          : formatSignedMoney(
                                              item.purchasePriceDiff,
                                              labels.priceNotSet
                                            ),
                                      valueColor: "#92400e",
                                    }
                                  : null,
                                hasMissingPurchasePrice(item)
                                  ? {
                                      key: "missing_price",
                                      emoji: MONTHLY_SIGNAL_EMOJIS.missingPrice,
                                      label: labels.purchaseAmountMissing,
                                      value: "",
                                      valueColor: "#92400e",
                                    }
                                  : null,
                              ];
                              const movementSignals = movementSignalCandidates.filter(
                                (signal): signal is MovementSignal => signal !== null
                              );
                              const quantityRows: DetailRow[] = [
                                {
                                  label: detailLabels.baselineShort,
                                  value:
                                    item.baselineQuantity === null
                                      ? labels.noSnapshot
                                      : formatQuantityWithUnit(item.baselineQuantity, item.unit),
                                },
                                {
                                  label: detailLabels.latestShort,
                                  value:
                                    item.latestQuantity === null
                                      ? "-"
                                      : formatQuantityWithUnit(item.latestQuantity, item.unit),
                                },
                                {
                                  label: detailLabels.previousMonthChange,
                                  value: formatSignedQuantityWithUnit(
                                    item.stockNetChange,
                                    item.unit
                                  ),
                                  color:
                                    item.stockNetChange === 0
                                      ? "#9ca3af"
                                      : getSignedColor(item.stockNetChange),
                                },
                              ];
                              const purchaseRows: DetailRow[] =
                                item.purchaseQuantity > 0
                                  ? [
                                      {
                                        label: detailLabels.purchaseQuantity,
                                        value: formatSignedQuantityWithUnit(
                                          item.purchaseQuantity,
                                          item.unit
                                        ),
                                        color: "seagreen",
                                      },
                                      {
                                        label: detailLabels.purchaseAmountKnown,
                                        value: formatMoney(
                                          item.purchaseAmount,
                                          `${MONTHLY_SIGNAL_EMOJIS.missingPrice} ${labels.priceNotSet}`
                                        ),
                                        color:
                                          item.purchaseAmount === null ? "#92400e" : "#111827",
                                      },
                                    ]
                                  : [];
                              const priceRowCandidates: Array<DetailRow | null> = [
                                (item.registeredPrice ??
                                  item.baselinePurchasePrice ??
                                  item.latestPurchasePrice) !== null
                                  ? {
                                      label: detailLabels.registeredPrice,
                                      value: formatMoney(
                                        item.registeredPrice ??
                                          item.baselinePurchasePrice ??
                                          item.latestPurchasePrice,
                                        labels.priceNotSet
                                      ),
                                    }
                                  : null,
                                item.latestPurchasePrice !== null
                                  ? {
                                      label: detailLabels.currentUnitPrice,
                                      value: formatMoney(
                                        item.latestPurchasePrice,
                                        labels.priceNotSet
                                      ),
                                    }
                                  : null,
                                hasPurchasePriceChange(item)
                                  ? {
                                      label: detailLabels.priceChange,
                                      value: formatSignedMoney(
                                        item.purchasePriceDiff,
                                        labels.priceNotSet
                                      ),
                                      color: getSignedColor(item.purchasePriceDiff ?? 0),
                                    }
                                  : null,
                                hasPurchasePriceChange(item) &&
                                item.priceChangeEvents.length === 0
                                  ? {
                                      label: labels.priceChangedDate,
                                      value: item.priceChangedDate
                                        ? formatShortDate(item.priceChangedDate, "")
                                        : labels.priceChangedDateUnknown,
                                      color: item.priceChangedDate ? undefined : "#6b7280",
                                    }
                                  : null,
                                item.purchaseAmountMissing
                                  ? {
                                      label: labels.purchaseAmountMissing,
                                      value: `${MONTHLY_SIGNAL_EMOJIS.missingPrice} ${labels.priceNotSet}`,
                                      color: "#92400e",
                                    }
                                  : null,
                              ];
                              const priceRows = priceRowCandidates.filter(
                                (row): row is DetailRow => row !== null
                              );
                              const movementRowCandidates: Array<DetailRow | null> = [
                                item.stockCheckNetChange !== 0
                                  ? {
                                      label: detailLabels.stockCheckNetChange,
                                      value: formatSignedQuantityWithUnit(
                                        item.stockCheckNetChange,
                                        item.unit
                                      ),
                                      color: getSignedColor(item.stockCheckNetChange),
                                    }
                                  : null,
                                item.serviceNetChange !== 0
                                  ? {
                                      label: labels.serviceNetChange,
                                      value: formatSignedQuantityWithUnit(
                                        item.serviceNetChange,
                                        item.unit
                                      ),
                                      color: getSignedColor(item.serviceNetChange),
                                    }
                                  : null,
                                item.otherNetChange !== 0
                                  ? {
                                      label: labels.otherNetChange,
                                      value: formatSignedQuantityWithUnit(
                                        item.otherNetChange,
                                        item.unit
                                      ),
                                      color: getSignedColor(item.otherNetChange),
                                    }
                                  : null,
                              ];
                              const movementRows = movementRowCandidates.filter(
                                (row): row is DetailRow => row !== null
                              );
                              const detailSections = [
                                { key: "quantity", title: labels.quantitySection, rows: quantityRows },
                                ...(purchaseRows.length > 0
                                  ? [
                                      {
                                        key: "purchase",
                                        title: labels.purchaseSection,
                                        rows: purchaseRows,
                                      },
                                    ]
                                  : []),
                                ...(priceRows.length > 0
                                  ? [
                                      {
                                        key: "price",
                                        title: labels.priceSection,
                                        rows: priceRows,
                                      },
                                    ]
                                  : []),
                                ...(movementRows.length > 0
                                  ? [
                                      {
                                        key: "movement",
                                        title: detailLabels.movementSection,
                                        rows: movementRows,
                                      },
                                    ]
                                  : []),
                              ];
                              return (
                                <div
                                  key={item.itemId}
                                  style={{
                                    border: "1px solid #e5e7eb",
                                    borderLeft: `4px solid ${getStatusColor(item.status)}`,
                                    borderRadius: 8,
                                    background: "#fff",
                                    padding: "7px 9px",
                                  }}
                                >
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  onClick={() =>
                                    setExpandedItemIds((prev) => ({
                                      ...prev,
                                      [item.itemId]: !prev[item.itemId],
                                    }))
                                  }
                                  style={{
                                    width: "100%",
                                    border: "none",
                                    background: "transparent",
                                    padding: 0,
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 3,
                                    textAlign: "left",
                                    cursor: "pointer",
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: "minmax(0, 1fr) auto auto",
                                      gap: 8,
                                      alignItems: "center",
                                    }}
                                  >
                                    <span
                                      style={{
                                        minWidth: 0,
                                        display: "flex",
                                        alignItems: "baseline",
                                        gap: 5,
                                        overflow: "hidden",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      <span
                                        style={{
                                          minWidth: 0,
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                          fontSize: 13,
                                          fontWeight: 900,
                                          color: "#111827",
                                        }}
                                      >
                                        {displayName}
                                      </span>
                                      {item.code && (
                                        <span
                                          style={{
                                            flexShrink: 0,
                                            fontSize: 11,
                                            fontWeight: 900,
                                            color: "#4b5563",
                                            background: "#f3f4f6",
                                            border: "1px solid #e5e7eb",
                                            borderRadius: 6,
                                            padding: "1px 4px",
                                            lineHeight: 1.35,
                                          }}
                                        >
                                          {item.code}
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: 12,
                                        fontWeight: 900,
                                        color: "#111827",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {formatQuantityWithUnit(item.latestQuantity, item.unit)}
                                    </span>
                                    <span
                                      style={{
                                        color: "#6b7280",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        width: 18,
                                        height: 18,
                                      }}
                                    >
                                      <ChevronIcon open={expanded} />
                                    </span>
                                  </div>

                                  {item.purchaseQuantity > 0 && (
                                    <div
                                      style={{
                                        border: "1px solid #e5e7eb",
                                        borderRadius: 8,
                                        background: "#f9fafb",
                                        padding: "6px 8px",
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        gap: 10,
                                        minWidth: 0,
                                        cursor: "default",
                                      }}
                                    >
                                      <span
                                        style={{
                                          fontSize: 12,
                                          fontWeight: 900,
                                          color: "#111827",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {MONTHLY_REASON_EMOJIS.purchase} {labels.purchase}{" "}
                                        <span style={{ color: "seagreen" }}>
                                          {formatSignedQuantity(item.purchaseQuantity)}
                                        </span>
                                      </span>
                                      <span
                                        style={{
                                          minWidth: 0,
                                          fontSize: 12,
                                          fontWeight: 900,
                                          color:
                                            item.purchaseAmount === null ? "#92400e" : "#111827",
                                          textAlign: "right",
                                          whiteSpace: "nowrap",
                                          overflow: "hidden",
                                          textOverflow: "ellipsis",
                                        }}
                                      >
                                        {itemAmountText}
                                      </span>
                                    </div>
                                  )}

                                  {movementSignals.length > 0 && (
                                    <div
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        flexWrap: "wrap",
                                        gap: "2px 7px",
                                        minWidth: 0,
                                        fontSize: 12,
                                        fontWeight: 800,
                                        color: "#6b7280",
                                        cursor: "default",
                                      }}
                                    >
                                      {movementSignals.map((signal, index) => (
                                        <span
                                          key={signal.key}
                                          style={{
                                            whiteSpace: "nowrap",
                                          }}
                                        >
                                          {index > 0 ? SEP : ""}
                                          {signal.emoji} {signal.label}
                                          {signal.value && (
                                            <>
                                              {" "}
                                              <span style={{ color: signal.valueColor }}>
                                                {signal.value}
                                              </span>
                                            </>
                                          )}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </button>

                                {expanded && (
                                  <div
                                    style={{
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: 8,
                                      marginTop: 8,
                                      paddingTop: 8,
                                      borderTop: "1px solid #f1f5f9",
                                    }}
                                  >
                                    {detailSections.map((section) => (
                                      <div
                                        key={section.key}
                                        style={{
                                          minWidth: 0,
                                          border: "1px solid #e5e7eb",
                                          borderRadius: 8,
                                          background: "#f9fafb",
                                          padding: "7px 8px",
                                        }}
                                      >
                                        <div
                                          style={{
                                            ...ui.metaText,
                                            fontWeight: 900,
                                            color: "#374151",
                                            marginBottom: 3,
                                          }}
                                        >
                                          {section.title}
                                        </div>
                                        <div
                                          style={{
                                            display: "flex",
                                            flexDirection: "column",
                                            gap: 4,
                                          }}
                                        >
                                          {section.rows.map((row) => (
                                            <div
                                              key={`${section.key}-${row.label}`}
                                              style={{
                                                minWidth: 0,
                                                display: "flex",
                                                justifyContent: "space-between",
                                                alignItems: "center",
                                                gap: 8,
                                                fontSize: 12,
                                                lineHeight: 1.35,
                                              }}
                                            >
                                              <span
                                                style={{
                                                  color: "#6b7280",
                                                  fontWeight: 800,
                                                  flexShrink: 0,
                                                  whiteSpace: "nowrap",
                                                }}
                                              >
                                                {row.label}
                                              </span>
                                              <span
                                                style={{
                                                  minWidth: 0,
                                                  color: row.color ?? "#111827",
                                                  fontWeight: 900,
                                                  textAlign: "right",
                                                  whiteSpace: "nowrap",
                                                  overflowWrap: "normal",
                                                }}
                                              >
                                                {row.value}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                        {section.key === "price" &&
                                          item.priceChangeEvents.length > 0 && (
                                            <div
                                              style={{
                                                marginTop: 7,
                                                paddingTop: 7,
                                                borderTop: "1px solid #e5e7eb",
                                                display: "flex",
                                                flexDirection: "column",
                                                gap: 4,
                                              }}
                                            >
                                              <div
                                                style={{
                                                  ...ui.metaText,
                                                  fontWeight: 900,
                                                  color: "#374151",
                                                }}
                                              >
                                                {detailLabels.priceChangeHistory}
                                              </div>
                                              {item.priceChangeEvents.map((event, index) => (
                                                <div
                                                  key={`${event.businessDate}-${event.newPrice}-${index}`}
                                                  style={{
                                                    display: "flex",
                                                    justifyContent: "space-between",
                                                    gap: 8,
                                                    fontSize: 12,
                                                    lineHeight: 1.35,
                                                  }}
                                                >
                                                  <span
                                                    style={{
                                                      color: "#6b7280",
                                                      fontWeight: 800,
                                                      whiteSpace: "nowrap",
                                                    }}
                                                  >
                                                    {formatShortDate(event.businessDate, "")}
                                                  </span>
                                                  <span
                                                    style={{
                                                      minWidth: 0,
                                                      color: "#111827",
                                                      fontWeight: 900,
                                                      textAlign: "right",
                                                      wordBreak: "break-word",
                                                    }}
                                                  >
                                                    {formatMoney(event.newPrice, "-")}{" "}
                                                    {event.diff !== null && (
                                                      <span
                                                        style={{
                                                          color: getSignedColor(event.diff),
                                                        }}
                                                      >
                                                        (
                                                        {formatSignedMoney(
                                                          event.diff,
                                                          ""
                                                        ).replace(" VND", "")}
                                                        )
                                                      </span>
                                                    )}{" "}
                                                    {SEP}
                                                    {getPriceChangeLabel(event, lang)}
                                                  </span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                </div>
                              );
                                })}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      ) : null}
    </Container>
  );
}
