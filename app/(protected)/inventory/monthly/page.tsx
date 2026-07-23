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
import { fetchInventoryApi } from "@/lib/inventory/client-auth";

type MonthlyItemStatus = "existing" | "new" | "missing";

type MonthlyItem = {
  itemId: number;
  code: string | null;
  name: string;
  nameVi: string | null;
  unit: string | null;
  supplier: string | null;
  supplierLabel: string | null;
  part: string | null;
  category: string | null;
  categoryVi: string | null;
  baselineQuantity: number | null;
  latestQuantity: number | null;
  stockNetChange: number;
  baselinePurchasePrice: number | null;
  latestPurchasePrice: number | null;
  registeredPrice: number | null;
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
  saleDeductionNetChange: number;
  saleDeductionDeduction: number;
  stockCheckDeduction: number;
  serviceDeduction: number;
  otherDeduction: number;
  saleDeductionAmount?: number | null;
  saleDeductionAmountMissing?: boolean;
  estimatedDeductionAmount: number | null;
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
  supplierLabel: string | null;
  itemCount: number;
  purchaseQuantity: number;
  purchaseAmountKnown: number;
  purchaseAmountMissingCount: number;
  items: MonthlyItem[];
};

type SupplierGroup = {
  key: string;
  supplier: string | null;
  supplierLabel: string;
  summary: SupplierSummary | null;
  items: MonthlyItem[];
  deductionOnlyItems: MonthlyItem[];
};

type CategoryGroup = {
  key: string;
  label: string;
  items: MonthlyItem[];
};

type CategorySummary = {
  key: string;
  label: string;
  totalAmount: number;
  totalQuantity: number;
  missingCount: number;
};

type PartSummary = {
  key: string;
  label: string;
  totalAmount: number;
  totalQuantity: number;
  missingCount: number;
  categories: CategorySummary[];
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
    saleDeductionNetChange: number;
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
    saleShort: "판매",
    saleDeductionKindUnit: "종",
    deductionOnlyBadge: "당월 입고 없음",
    deductionOnlyNoSupplierSection: "당월 입고 없는 판매차감 · 거래처 미지정",
    previousMonthChange: "전월대비",
    itemCountUnit: "품목",
    logCountUnit: "건",
    chipHint: "품목 종류 기준",
    baseRange: "기준",
    noSnapshot: "스냅샷 없음",
    currentInventory: "현재 재고 기준",
    notClosingSnapshot: "마감 스냅샷 아님",
    snapshotSource: "스냅샷 기준",
    supplierSummary: "거래처별 요약",
    supplierView: "거래처별",
    partView: "파트별",
    partSummary: "파트별 요약",
    spendingShare: "지출 비중",
    noPart: "파트 없음",
    noCategory: "카테고리 없음",
    missingUnitPrice: "단가 누락",
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
    monthlyNew: "신규",
    monthlyMissing: "누락",
    deductionSection: "차감 현황",
    deductionLabel: "차감",
    deductionNotice: "차감은 월간 입고금액 대비 추정 차감금액 기준입니다.",
    deductionEmpty: "이번 달 차감 기록이 없습니다.",
    deductionSaleDeduction: "판매차감",
    deductionStockCheck: "재고확인",
    deductionService: "서비스&증정",
    deductionOther: "기타",
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
    saleShort: "Bán",
    saleDeductionKindUnit: " loại",
    deductionOnlyBadge: "Không nhập T.này",
    deductionOnlyNoSupplierSection: "Trừ bán không nhập trong tháng · Chưa có nơi mua",
    previousMonthChange: "So thang truoc",
    itemCountUnit: " mat hang",
    logCountUnit: "luot",
    chipHint: "Theo số loại",
    baseRange: "Chuan",
    noSnapshot: "Khong co snapshot",
    currentInventory: "Theo kho hien tai",
    notClosingSnapshot: "Khong phai snapshot chot",
    snapshotSource: "Theo snapshot",
    supplierSummary: "Tom tat theo noi mua",
    supplierView: "Theo nơi mua",
    partView: "Theo bộ phận",
    partSummary: "Tổng hợp theo bộ phận",
    spendingShare: "Tỷ trọng chi phí",
    noPart: "Chưa có bộ phận",
    noCategory: "Chưa có danh mục",
    missingUnitPrice: "Thiếu đơn giá",
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
    monthlyNew: "mới",
    monthlyMissing: "thiếu",
    deductionSection: "Biến động trừ kho",
    deductionLabel: "Trừ",
    deductionNotice: "Trừ kho là giá trị trừ ước tính so với tổng giá trị nhập trong tháng.",
    deductionEmpty: "Không có dữ liệu trừ kho trong tháng này.",
    deductionSaleDeduction: "Trừ bán hàng",
    deductionStockCheck: "Kiểm tra kho",
    deductionService: "Dịch vụ/tặng",
    deductionOther: "Khác",
  },
} as const;

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
  sale_deduction: "🔴",
} as const;

const getSalesDeductionLabel = (lang: "ko" | "vi") =>
  lang === "vi" ? "Trừ kho bán hàng" : "판매차감";


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

  // Empty means "let the server resolve the current business month" — the
  // client never computes the 03:00/Asia-Ho_Chi_Minh cutoff itself. The fetch
  // effect below omits the month query param in that case and syncs state
  // from the API's resolved month once the response arrives.
  const [selectedMonth, setSelectedMonth] = useState("");
  const [data, setData] = useState<MonthlyInventoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [summaryView, setSummaryView] = useState<"supplier" | "part">("supplier");
  const [expandedSupplierKeys, setExpandedSupplierKeys] = useState<Record<string, boolean>>({});
  const [expandedParts, setExpandedParts] = useState<Record<string, boolean>>({});
  const [expandedItemIds, setExpandedItemIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let ignore = false;

    const fetchMonthly = async () => {
      setLoading(true);
      setError("");

      try {
        const query = selectedMonth ? `?month=${selectedMonth}` : "";
        const res = await fetchInventoryApi(`/api/inventory/monthly${query}`, {
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
          setExpandedParts({});
          setExpandedItemIds({});

          if (!selectedMonth && json.month) {
            setSelectedMonth(json.month);
          }
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
        items: supplier.items ?? [],
        deductionOnlyItems: [],
      });
    }

    const purchaseItemIds = new Set<number>();
    for (const group of map.values())
      for (const item of group.items)
        purchaseItemIds.add(item.itemId);

    for (const item of data.items) {
      if (purchaseItemIds.has(item.itemId)) continue;
      if (item.saleDeductionDeduction <= 0) continue;
      const supplier = item.supplier?.trim() || null;
      if (!supplier) continue;
      const key = getSupplierKey(supplier);
      const existing = map.get(key);
      if (existing) {
        existing.deductionOnlyItems.push(item);
      } else {
        map.set(key, {
          key,
          supplier,
          supplierLabel: item.supplierLabel || labels.unregisteredSupplier,
          summary: null,
          items: [],
          deductionOnlyItems: [item],
        });
      }
    }

    const sortItems = (a: MonthlyItem, b: MonthlyItem) => {
      const aCode = sortText(a.code);
      const bCode = sortText(b.code);
      if (aCode && !bCode) return -1;
      if (!aCode && bCode) return 1;
      const codeCompare = sortText(a.code).localeCompare(sortText(b.code));
      if (codeCompare !== 0) return codeCompare;
      return sortText(a.name || a.nameVi).localeCompare(sortText(b.name || b.nameVi));
    };

    return [...map.values()]
      .map((group) => ({
        ...group,
        items: [...group.items].sort(sortItems),
        deductionOnlyItems: [...group.deductionOnlyItems].sort(sortItems),
      }))
      .sort((a, b) => {
        const amountDiff =
          (b.summary?.purchaseAmountKnown ?? 0) -
          (a.summary?.purchaseAmountKnown ?? 0);
        if (amountDiff !== 0) return amountDiff;

        const quantityDiff =
          (b.summary?.purchaseQuantity ?? 0) -
          (a.summary?.purchaseQuantity ?? 0);
        if (quantityDiff !== 0) return quantityDiff;

        return sortText(a.supplierLabel).localeCompare(sortText(b.supplierLabel));
      });
  }, [data, labels.unregisteredSupplier]);

  const supplierAmountStats = useMemo(
    () =>
      supplierGroups.reduce(
        (stats, group) => {
          const amount = group.summary?.purchaseAmountKnown ?? 0;
          return {
            total: stats.total + amount,
            max: Math.max(stats.max, amount),
          };
        },
        { total: 0, max: 0 }
      ),
    [supplierGroups]
  );

  const partGroups = useMemo<PartSummary[]>(() => {
    type CategoryAccumulator = CategorySummary;
    type PartAccumulator = Omit<PartSummary, "categories"> & {
      categoryMap: Map<string, CategoryAccumulator>;
    };

    const partMap = new Map<string, PartAccumulator>();

    for (const item of supplierGroups.flatMap((group) => group.items)) {
      const rawPart = item.part?.trim() || "";
      const partKey = rawPart || "__none__";
      const partLabel =
        rawPart === "kitchen" || rawPart === "hall" || rawPart === "bar"
          ? String(c[rawPart as keyof typeof c])
          : rawPart || labels.noPart;
      const rawCategory = item.category?.trim() || item.categoryVi?.trim() || "";
      const categoryKey = rawCategory || "__none__";
      const categoryLabel =
        (lang === "vi"
          ? item.categoryVi || item.category
          : item.category || item.categoryVi) || labels.noCategory;
      const amount = item.purchaseAmount ?? 0;
      const quantity = item.purchaseQuantity;
      const missingCount = hasMissingPurchasePrice(item) ? 1 : 0;
      const part =
        partMap.get(partKey) ??
        ({
          key: partKey,
          label: partLabel,
          totalAmount: 0,
          totalQuantity: 0,
          missingCount: 0,
          categoryMap: new Map<string, CategoryAccumulator>(),
        } satisfies PartAccumulator);
      const category =
        part.categoryMap.get(categoryKey) ??
        ({
          key: categoryKey,
          label: categoryLabel,
          totalAmount: 0,
          totalQuantity: 0,
          missingCount: 0,
        } satisfies CategoryAccumulator);

      part.totalAmount += amount;
      part.totalQuantity += quantity;
      part.missingCount += missingCount;
      category.totalAmount += amount;
      category.totalQuantity += quantity;
      category.missingCount += missingCount;
      part.categoryMap.set(categoryKey, category);
      partMap.set(partKey, part);
    }

    return [...partMap.values()]
      .map((part) => ({
        key: part.key,
        label: part.label,
        totalAmount: part.totalAmount,
        totalQuantity: part.totalQuantity,
        missingCount: part.missingCount,
        categories: [...part.categoryMap.values()].sort((a, b) => {
          const amountDiff = b.totalAmount - a.totalAmount;
          if (amountDiff !== 0) return amountDiff;
          const quantityDiff = b.totalQuantity - a.totalQuantity;
          if (quantityDiff !== 0) return quantityDiff;
          return sortText(a.label).localeCompare(sortText(b.label));
        }),
      }))
      .sort((a, b) => {
        const amountDiff = b.totalAmount - a.totalAmount;
        if (amountDiff !== 0) return amountDiff;
        const quantityDiff = b.totalQuantity - a.totalQuantity;
        if (quantityDiff !== 0) return quantityDiff;
        return sortText(a.label).localeCompare(sortText(b.label));
      });
  }, [supplierGroups, c, labels.noCategory, labels.noPart, lang]);

  type DeductionAmtData = { sale: number; check: number; service: number; other: number; total: number };

  const deductionByItem = useMemo(() => {
    const map = new Map<number, DeductionAmtData>();
    for (const item of data?.items ?? []) {
      const totalQty = item.saleDeductionDeduction + item.stockCheckDeduction + item.serviceDeduction + item.otherDeduction;
      if (totalQty === 0) continue;
      const saleAmt = item.saleDeductionAmount ?? 0;
      const totalAmt = item.estimatedDeductionAmount ?? 0;
      const otherAmt = Math.max(0, totalAmt - saleAmt);
      const otherQty = item.stockCheckDeduction + item.serviceDeduction + item.otherDeduction;
      map.set(item.itemId, {
        sale: saleAmt,
        check: otherQty > 0 ? otherAmt * (item.stockCheckDeduction / otherQty) : 0,
        service: otherQty > 0 ? otherAmt * (item.serviceDeduction / otherQty) : 0,
        other: otherQty > 0 ? otherAmt * (item.otherDeduction / otherQty) : 0,
        total: totalAmt,
      });
    }
    return map;
  }, [data]);

  const partDeductionData = useMemo(() => {
    const map = new Map<string, DeductionAmtData>();
    for (const item of data?.items ?? []) {
      const partKey = item.part?.trim() || "__none__";
      const d = deductionByItem.get(item.itemId);
      if (!d) continue;
      const existing = map.get(partKey) ?? { sale: 0, check: 0, service: 0, other: 0, total: 0 };
      existing.sale += d.sale; existing.check += d.check; existing.service += d.service; existing.other += d.other; existing.total += d.total;
      map.set(partKey, existing);
    }
    return map;
  }, [data, deductionByItem]);

  const categoryDeductionData = useMemo(() => {
    const map = new Map<string, DeductionAmtData>();
    for (const item of data?.items ?? []) {
      const partKey = item.part?.trim() || "__none__";
      const rawCategory = item.category?.trim() || item.categoryVi?.trim() || "";
      const categoryKey = rawCategory || "__none__";
      const d = deductionByItem.get(item.itemId);
      if (!d) continue;
      const key = `${partKey}:${categoryKey}`;
      const existing = map.get(key) ?? { sale: 0, check: 0, service: 0, other: 0, total: 0 };
      existing.sale += d.sale; existing.check += d.check; existing.service += d.service; existing.other += d.other; existing.total += d.total;
      map.set(key, existing);
    }
    return map;
  }, [data, deductionByItem]);

  const supplierDeductionData = useMemo(() => {
    const itemTotalPurchase = new Map<number, number>();
    for (const group of supplierGroups)
      for (const item of group.items)
        itemTotalPurchase.set(item.itemId, (itemTotalPurchase.get(item.itemId) ?? 0) + (item.purchaseAmount ?? 0));

    const map = new Map<string, DeductionAmtData>();
    for (const group of supplierGroups) {
      const acc: DeductionAmtData = { sale: 0, check: 0, service: 0, other: 0, total: 0 };
      for (const item of [...group.items, ...group.deductionOnlyItems]) {
        const d = deductionByItem.get(item.itemId);
        if (!d || d.total === 0) continue;
        const totalPurchase = itemTotalPurchase.get(item.itemId) ?? 0;
        const share = totalPurchase > 0 ? (item.purchaseAmount ?? 0) / totalPurchase : 1;
        acc.sale += d.sale * share; acc.check += d.check * share;
        acc.service += d.service * share; acc.other += d.other * share; acc.total += d.total * share;
      }
      map.set(group.key, acc);
    }
    return map;
  }, [supplierGroups, deductionByItem]);

  const partAmountStats = useMemo(
    () =>
      partGroups.reduce(
        (stats, part) => ({
          total: stats.total + part.totalAmount,
          max: Math.max(stats.max, part.totalAmount),
        }),
        { total: 0, max: 0 }
      ),
    [partGroups]
  );

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

  const deductionNoSupplierItems = useMemo<MonthlyItem[]>(() => {
    if (!data) return [];
    const coveredIds = new Set<number>(
      supplierGroups.flatMap((g) => [
        ...g.items.map((i) => i.itemId),
        ...g.deductionOnlyItems.map((i) => i.itemId),
      ])
    );
    return data.items.filter(
      (item) => item.saleDeductionDeduction > 0 && !coveredIds.has(item.itemId)
    );
  }, [data, supplierGroups]);

  const {
    serviceChangedItemCount,
    salesDeductionChangedItemCount,
    stockCheckIncreaseCount,
    stockCheckDecreaseCount,
    otherIncreaseCount,
    otherDecreaseCount,
    missingPriceItemCount,
    priceChangedItemCount,
  } = useMemo(() => {
    let serviceChangedItemCount = 0;
    let salesDeductionChangedItemCount = 0;
    let stockCheckIncreaseCount = 0;
    let stockCheckDecreaseCount = 0;
    let otherIncreaseCount = 0;
    let otherDecreaseCount = 0;
    let missingPriceItemCountFallback = 0;
    let priceChangedItemCount = 0;

    for (const item of data?.items ?? []) {
      if (item.serviceNetChange !== 0) serviceChangedItemCount += 1;
      if (item.saleDeductionNetChange !== 0) salesDeductionChangedItemCount += 1;
      if (item.stockCheckNetChange > 0) stockCheckIncreaseCount += 1;
      if (item.stockCheckNetChange < 0) stockCheckDecreaseCount += 1;
      if (item.otherNetChange > 0) otherIncreaseCount += 1;
      if (item.otherNetChange < 0) otherDecreaseCount += 1;
      if (hasMissingPurchasePrice(item)) missingPriceItemCountFallback += 1;
      if (hasPurchasePriceChange(item)) priceChangedItemCount += 1;
    }

    return {
      serviceChangedItemCount,
      salesDeductionChangedItemCount,
      stockCheckIncreaseCount,
      stockCheckDecreaseCount,
      otherIncreaseCount,
      otherDecreaseCount,
      missingPriceItemCount:
        data?.summary.purchaseAmountMissingCount ?? missingPriceItemCountFallback,
      priceChangedItemCount,
    };
  }, [data]);

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

            {(() => {
              const chipStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3, whiteSpace: "nowrap", padding: "4px 8px", borderRadius: 8, background: "#fff", border: "1px solid #e5e7eb", minHeight: 28 };
              return (
                <>
                <div style={{ marginTop: 6, fontSize: 10, color: "#9ca3af", fontWeight: 600, textAlign: "center" }}>
                  {labels.chipHint}
                </div>
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#374151" }}>
                  <span style={chipStyle}><span>{MONTHLY_SIGNAL_EMOJIS.priceChange}</span><span>{labels.priceChanged}</span>{priceChangedItemCount > 0 ? <b>{formatQuantity(priceChangedItemCount)}{labels.itemCountUnit}</b> : <b style={{ color: "#9ca3af" }}>0{labels.itemCountUnit}</b>}</span>
                  <span style={chipStyle}><span>{MONTHLY_REASON_EMOJIS.purchase}</span><span>{labels.purchase}</span><b style={{ color: data.summary.purchaseItemCount > 0 ? "#2563eb" : "#9ca3af" }}>{data.summary.purchaseItemCount > 0 ? `+${formatQuantity(data.summary.purchaseItemCount)}` : "0"}</b></span>
                  {missingPriceItemCount > 0 && <span style={chipStyle}><span>{MONTHLY_SIGNAL_EMOJIS.missingPrice}</span><span>{labels.purchaseAmountMissing}</span><b>{formatQuantity(missingPriceItemCount)}</b></span>}
                  <span style={chipStyle}><span>{MONTHLY_REASON_EMOJIS.sale_deduction}</span><span>{labels.saleShort}</span><b style={{ color: salesDeductionChangedItemCount > 0 ? "#ef4444" : "#9ca3af" }}>{salesDeductionChangedItemCount > 0 ? `-${formatQuantity(salesDeductionChangedItemCount)}` : "0"}</b></span>
                  {(stockCheckIncreaseCount > 0 || stockCheckDecreaseCount > 0) && (
                    <span style={chipStyle}><span>{MONTHLY_REASON_EMOJIS.stock_check}</span><span>{labels.stockCheckShort}</span>{stockCheckIncreaseCount > 0 && <b style={{ color: "seagreen" }}>+{formatQuantity(stockCheckIncreaseCount)}</b>}{stockCheckIncreaseCount > 0 && stockCheckDecreaseCount > 0 && <span style={{ color: "#9ca3af" }}>/</span>}{stockCheckDecreaseCount > 0 && <b style={{ color: "#ef4444" }}>-{formatQuantity(stockCheckDecreaseCount)}</b>}</span>
                  )}
                  {serviceChangedItemCount > 0 && (
                    <span style={chipStyle}><span>{MONTHLY_REASON_EMOJIS.service}</span><span>{labels.serviceShort}</span><b style={{ color: "#ef4444" }}>-{formatQuantity(serviceChangedItemCount)}</b></span>
                  )}
                  {(otherIncreaseCount > 0 || otherDecreaseCount > 0) && (
                    <span style={chipStyle}><span>{MONTHLY_REASON_EMOJIS.other}</span><span>{labels.otherNetChange}</span>{otherIncreaseCount > 0 && <b style={{ color: "seagreen" }}>+{formatQuantity(otherIncreaseCount)}</b>}{otherIncreaseCount > 0 && otherDecreaseCount > 0 && <span style={{ color: "#9ca3af" }}>/</span>}{otherDecreaseCount > 0 && <b style={{ color: "#ef4444" }}>-{formatQuantity(otherDecreaseCount)}</b>}</span>
                  )}
                </div>
                </>
              );
            })()}
          </section>

          <div
            role="tablist"
            aria-label={labels.summary}
            style={{
              ...ui.card,
              padding: 4,
              marginBottom: 12,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 4,
            }}
          >
            {(["supplier", "part"] as const).map((view) => {
              const active = summaryView === view;
              return (
                <button
                  key={view}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSummaryView(view)}
                  style={{
                    border: active ? "1px solid #93c5fd" : "1px solid transparent",
                    borderRadius: 8,
                    background: active ? "#eff6ff" : "transparent",
                    color: active ? "#1d4ed8" : "#6b7280",
                    padding: "8px 10px",
                    fontSize: 13,
                    fontWeight: 900,
                    cursor: "pointer",
                    boxShadow: active ? "0 1px 2px rgba(15, 23, 42, 0.08)" : "none",
                  }}
                >
                  {view === "supplier" ? labels.supplierView : labels.partView}
                </button>
              );
            })}
          </div>

          {summaryView === "supplier" && (
          <section style={{ ...ui.card, padding: 12, marginBottom: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "2px 8px", marginBottom: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
                {labels.supplierSummary} ({supplierGroups.length})
              </span>
              <span style={{ fontSize: 10, color: "#6b7280", whiteSpace: "nowrap" }}>
                <span style={{ display: "inline-block", width: 10, height: 4, background: "#2563eb", borderRadius: 2, marginRight: 3, verticalAlign: "middle" }} />{labels.purchase}
              </span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px", fontSize: 10, color: "#6b7280", marginBottom: 10 }}>
              <span><span style={{ color: "#ef4444" }}>●</span> {labels.deductionSaleDeduction}</span>
              <span><span style={{ color: "seagreen" }}>●</span> {labels.deductionStockCheck}</span>
              <span><span style={{ color: "#8b5cf6" }}>●</span> {labels.deductionService}</span>
              <span><span style={{ color: "#9ca3af" }}>●</span> {labels.deductionOther}</span>
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
                  const itemCount = (supplier?.itemCount ?? group.items.length) + group.deductionOnlyItems.length;
                  const supplierMissingPriceCount = group.items.filter(
                    hasMissingPurchasePrice
                  ).length;
                  const supplierPriceChangedCount = group.items.filter(
                    hasPurchasePriceChange
                  ).length;
                  const supplierServiceCount = group.items.filter(
                    (item) => item.serviceNetChange !== 0
                  ).length;
                  const supplierAmount = supplier?.purchaseAmountKnown ?? 0;
                  const supplierBarWidth =
                    supplierAmountStats.max > 0
                      ? (supplierAmount / supplierAmountStats.max) * 100
                      : 0;
                  const supplierShare =
                    supplierAmountStats.total > 0
                      ? (supplierAmount / supplierAmountStats.total) * 100
                      : 0;
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

                      <div
                        style={{
                          padding: "0 10px 8px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "grid",
                              gridTemplateColumns: "minmax(0, 1fr) 38px",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <div
                              style={{
                                height: 6,
                                overflow: "hidden",
                                borderRadius: 999,
                                background: "#e5e7eb",
                              }}
                            >
                              <div
                                style={{
                                  width: `${supplierBarWidth}%`,
                                  height: "100%",
                                  borderRadius: 999,
                                  background: "#2563eb",
                                }}
                              />
                            </div>
                            <span
                              style={{
                                textAlign: "right",
                                color: "#6b7280",
                                fontSize: 10,
                                fontWeight: 900,
                                whiteSpace: "nowrap",
                              }}
                            >
                              {supplierShare.toFixed(1)}%
                            </span>
                          </div>
                          {supplierSignals.length > 0 && (
                            <div
                              style={{
                                flexShrink: 0,
                                maxWidth: "32%",
                                display: "flex",
                                justifyContent: "flex-end",
                                flexWrap: "wrap",
                                gap: "2px 5px",
                                color: "#6b7280",
                                fontSize: 11,
                                fontWeight: 800,
                                textAlign: "right",
                              }}
                            >
                              {supplierSignals.map((signal) => (
                                <span key={signal} style={{ whiteSpace: "nowrap" }}>
                                  {signal}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        {(() => {
                          const d = supplierDeductionData.get(group.key) ?? { sale: 0, check: 0, service: 0, other: 0, total: 0 };
                          const barWidth = supplierAmountStats.total > 0 ? (d.total / supplierAmountStats.total) * 100 : 0;
                          const shareStr = supplierAmountStats.total > 0 ? ((d.total / supplierAmountStats.total) * 100).toFixed(1) : "0.0";
                          return (
                            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 38px", alignItems: "center", gap: 6 }}>
                              <div style={{ height: 5, borderRadius: 999, overflow: "hidden", background: "#e5e7eb" }}>
                                <div style={{ width: `${barWidth}%`, height: "100%", display: "flex" }}>
                                  {d.total > 0 && <><div style={{ flex: d.sale, background: "#ef4444" }} /><div style={{ flex: d.check, background: "seagreen" }} /><div style={{ flex: d.service, background: "#8b5cf6" }} /><div style={{ flex: d.other, background: "#9ca3af" }} /></>}
                                </div>
                              </div>
                              <span style={{ textAlign: "right", color: "#6b7280", fontSize: 10, fontWeight: 900, whiteSpace: "nowrap" }}>{shareStr}%</span>
                            </div>
                          );
                        })()}
                      </div>

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
                          {group.items.length === 0 && group.deductionOnlyItems.length === 0 ? (
                            <div style={{ ...ui.metaText, padding: "2px 2px" }}>
                              {labels.noData}
                            </div>
                          ) : (() => {
                            const deductionOnlyIds = new Set(group.deductionOnlyItems.map((i) => i.itemId));
                            const allGroupItems = [...group.items, ...group.deductionOnlyItems];
                            return getCategoryGroups(allGroupItems).map((categoryGroup) => (
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
                              const isDeductionOnly = deductionOnlyIds.has(item.itemId);
                              const itemExpansionKey = `${group.key}:${item.itemId}`;
                              const expanded = Boolean(expandedItemIds[itemExpansionKey]);
                              const displayName = getDisplayName(item);
                              const itemAmountText = getItemAmountText(item);
                              const stockCheckIncreaseQty = Math.max(0, item.stockCheckNetChange + item.stockCheckDeduction);
                              const otherIncreaseQty = Math.max(0, item.otherNetChange + item.otherDeduction);
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
                                item.saleDeductionNetChange !== 0
                                  ? {
                                      label: getSalesDeductionLabel(lang),
                                      value: formatSignedQuantityWithUnit(
                                        item.saleDeductionNetChange,
                                        item.unit
                                      ),
                                      color: getSignedColor(item.saleDeductionNetChange),
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
                                  key={itemExpansionKey}
                                  style={{
                                    border: "1px solid #e5e7eb",
                                    borderLeft: "4px solid #e5e7eb",
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
                                      [itemExpansionKey]: !prev[itemExpansionKey],
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
                                      {item.status !== "existing" && (
                                        <span
                                          style={{
                                            flexShrink: 0,
                                            fontSize: 10,
                                            fontWeight: 900,
                                            color:
                                              item.status === "new" ? "#166534" : "#991b1b",
                                            background:
                                              item.status === "new" ? "#f0fdf4" : "#fef2f2",
                                            border: `1px solid ${
                                              item.status === "new" ? "#bbf7d0" : "#fecaca"
                                            }`,
                                            borderRadius: 999,
                                            padding: "1px 5px",
                                            lineHeight: 1.35,
                                            whiteSpace: "nowrap",
                                          }}
                                        >
                                          {item.status === "new"
                                            ? labels.monthlyNew
                                            : labels.monthlyMissing}
                                        </span>
                                      )}
                                      {isDeductionOnly && (
                                        <span
                                          style={{
                                            flexShrink: 0,
                                            fontSize: 10,
                                            fontWeight: 800,
                                            color: "#9ca3af",
                                            background: "#f9fafb",
                                            border: "1px solid #e5e7eb",
                                            borderRadius: 6,
                                            padding: "1px 4px",
                                            lineHeight: 1.35,
                                            whiteSpace: "nowrap",
                                          }}
                                        >
                                          {labels.deductionOnlyBadge}
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
                                        gap: 6,
                                        minWidth: 0,
                                        cursor: "default",
                                      }}
                                    >
                                      <span style={{ fontSize: 12, fontWeight: 900, color: "#111827", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 5px", minWidth: 0 }}>
                                        <span style={{ whiteSpace: "nowrap" }}>
                                          {MONTHLY_REASON_EMOJIS.purchase} {labels.purchase}{" "}
                                          <span style={{ color: "#2563eb" }}>{formatSignedQuantity(item.purchaseQuantity)}</span>
                                        </span>
                                        {stockCheckIncreaseQty > 0 && <span style={{ color: "seagreen", whiteSpace: "nowrap" }}>✅ +{formatQuantity(stockCheckIncreaseQty)}</span>}
                                        {otherIncreaseQty > 0 && <span style={{ color: "seagreen", whiteSpace: "nowrap" }}>✏️ +{formatQuantity(otherIncreaseQty)}</span>}
                                      </span>
                                      <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 900, whiteSpace: "nowrap", color: item.purchaseAmount === null ? "#92400e" : "#6b7280" }}>
                                        {itemAmountText}
                                      </span>
                                    </div>
                                  )}

                                  {item.purchaseQuantity === 0 && (stockCheckIncreaseQty > 0 || otherIncreaseQty > 0) && (
                                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 5px", fontSize: 12, fontWeight: 900, cursor: "default" }}>
                                      {stockCheckIncreaseQty > 0 && <span style={{ color: "seagreen", whiteSpace: "nowrap" }}>✅ +{formatQuantity(stockCheckIncreaseQty)}</span>}
                                      {otherIncreaseQty > 0 && <span style={{ color: "seagreen", whiteSpace: "nowrap" }}>✏️ +{formatQuantity(otherIncreaseQty)}</span>}
                                    </div>
                                  )}

                                  {(item.saleDeductionDeduction > 0 || item.stockCheckDeduction > 0 || item.serviceDeduction > 0 || item.otherDeduction > 0 || hasPurchasePriceChange(item)) && (
                                    <div
                                      style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        gap: 6,
                                        minWidth: 0,
                                        fontSize: 12,
                                        fontWeight: 900,
                                        cursor: "default",
                                      }}
                                    >
                                      <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 5px", minWidth: 0 }}>
                                        {(item.saleDeductionDeduction > 0 || item.stockCheckDeduction > 0 || item.serviceDeduction > 0 || item.otherDeduction > 0) && <span style={{ color: "#9ca3af", fontSize: 11, fontWeight: 800, marginRight: 1 }}>{labels.deductionLabel}</span>}
                                        {item.saleDeductionDeduction > 0 && <span style={{ color: "#ef4444", whiteSpace: "nowrap" }} title={labels.deductionSaleDeduction}>🔴 -{formatQuantity(item.saleDeductionDeduction)}</span>}
                                        {item.stockCheckDeduction > 0 && <span style={{ color: "seagreen", whiteSpace: "nowrap" }} title={labels.deductionStockCheck}>✅ -{formatQuantity(item.stockCheckDeduction)}</span>}
                                        {item.serviceDeduction > 0 && <span style={{ color: "#8b5cf6", whiteSpace: "nowrap" }} title={labels.deductionService}>🎁 -{formatQuantity(item.serviceDeduction)}</span>}
                                        {item.otherDeduction > 0 && <span style={{ color: "#9ca3af", whiteSpace: "nowrap" }} title={labels.deductionOther}>✏️ -{formatQuantity(item.otherDeduction)}</span>}
                                      </span>
                                      {hasPurchasePriceChange(item) && (
                                        <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 900, whiteSpace: "nowrap", color: "#92400e" }}>
                                          {MONTHLY_SIGNAL_EMOJIS.priceChange}{" "}
                                          {item.priceChangeEvents.length > 0 ? `${item.priceChangeEvents.length}${labels.times}` : labels.priceChanged}
                                        </span>
                                      )}
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
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          )}

          {summaryView === "supplier" && deductionNoSupplierItems.length > 0 && (
            <section style={{ ...ui.card, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "#6b7280", marginBottom: 8 }}>
                {labels.deductionOnlyNoSupplierSection}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {deductionNoSupplierItems.map((item) => (
                  <div
                    key={item.itemId}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 8px",
                      borderRadius: 8,
                      background: "#fff",
                      border: "1px solid #fecdd3",
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#374151" }}>
                      {item.code && <span style={{ color: "#9ca3af", marginRight: 4 }}>[{item.code}]</span>}
                      {getDisplayName(item) ?? item.name}
                    </span>
                    <span style={{ flexShrink: 0, color: "#ef4444", whiteSpace: "nowrap" }}>
                      🔴 -{formatQuantity(item.saleDeductionDeduction)}{item.unit ? ` ${item.unit}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {summaryView === "part" && (
            <section style={{ ...ui.card, padding: 12, marginBottom: 12 }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "2px 8px", marginBottom: 4 }}>
                <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
                  {labels.partSummary} ({partGroups.length})
                </span>
                <span style={{ fontSize: 10, color: "#6b7280", whiteSpace: "nowrap" }}>
                  <span style={{ display: "inline-block", width: 10, height: 4, background: "#2563eb", borderRadius: 2, marginRight: 3, verticalAlign: "middle" }} />{labels.purchase}
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 10px", fontSize: 10, color: "#6b7280", marginBottom: 10 }}>
                <span><span style={{ color: "#ef4444" }}>●</span> {labels.deductionSaleDeduction}</span>
                <span><span style={{ color: "seagreen" }}>●</span> {labels.deductionStockCheck}</span>
                <span><span style={{ color: "#8b5cf6" }}>●</span> {labels.deductionService}</span>
                <span><span style={{ color: "#9ca3af" }}>●</span> {labels.deductionOther}</span>
              </div>

              {partGroups.length === 0 ? (
                <div style={{ ...ui.metaText, padding: "8px 2px" }}>
                  {labels.noData}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {partGroups.map((part) => {
                    const partBarWidth =
                      partAmountStats.max > 0
                        ? (part.totalAmount / partAmountStats.max) * 100
                        : 0;
                    const partShare =
                      partAmountStats.total > 0
                        ? (part.totalAmount / partAmountStats.total) * 100
                        : 0;
                    const expandedPart = Boolean(expandedParts[part.key]);
                    const maxCategoryAmount = part.categories.reduce(
                      (max, category) => Math.max(max, category.totalAmount),
                      0
                    );

                    return (
                      <div
                        key={part.key}
                        style={{
                          border: "1px solid #e5e7eb",
                          borderRadius: 10,
                          background: "#fff",
                          overflow: "hidden",
                        }}
                      >
                        <button
                          type="button"
                          aria-expanded={expandedPart}
                          onClick={() =>
                            setExpandedParts((prev) => ({
                              ...prev,
                              [part.key]: !prev[part.key],
                            }))
                          }
                          style={{
                            width: "100%",
                            border: "none",
                            background: "transparent",
                            padding: "9px 10px",
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(0, 1fr) auto auto",
                            alignItems: "baseline",
                            gap: 8,
                          }}
                        >
                          <span
                            style={{
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontSize: 14,
                              fontWeight: 900,
                              color: "#111827",
                            }}
                          >
                            {part.label}
                          </span>
                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: 13,
                              fontWeight: 900,
                              color: "#111827",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {formatMoney(part.totalAmount, labels.priceNotSet)}
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
                            <ChevronIcon open={expandedPart} />
                          </span>
                          </div>

                          <div
                          style={{
                            marginTop: 4,
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                            color: "#6b7280",
                            fontSize: 11,
                            fontWeight: 800,
                          }}
                        >
                          <span>
                            {labels.purchaseQuantity}{" "}
                            <b>{formatQuantity(part.totalQuantity)}</b>
                          </span>
                          <span style={{ whiteSpace: "nowrap" }}>
                            {labels.spendingShare} {partShare.toFixed(1)}%
                          </span>
                        </div>

                        <div
                          style={{
                            marginTop: 7,
                            height: 7,
                            overflow: "hidden",
                            borderRadius: 999,
                            background: "#e5e7eb",
                          }}
                        >
                          <div
                            style={{
                              width: `${partBarWidth}%`,
                              height: "100%",
                              borderRadius: 999,
                              background: "#2563eb",
                            }}
                          />
                          </div>
                          {(() => {
                            const d = partDeductionData.get(part.key) ?? { sale: 0, check: 0, service: 0, other: 0, total: 0 };
                            const barWidth = partAmountStats.total > 0 ? (d.total / partAmountStats.total) * 100 : 0;
                            const deductPct = partAmountStats.total > 0 ? ((d.total / partAmountStats.total) * 100).toFixed(1) : "0.0";
                            return (
                              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 38px", alignItems: "center", gap: 6, marginTop: 4 }}>
                                <div style={{ height: 5, borderRadius: 999, overflow: "hidden", background: "#e5e7eb" }}>
                                  <div style={{ width: `${barWidth}%`, height: "100%", display: "flex" }}>
                                    {d.total > 0 && <><div style={{ flex: d.sale, background: "#ef4444" }} /><div style={{ flex: d.check, background: "seagreen" }} /><div style={{ flex: d.service, background: "#8b5cf6" }} /><div style={{ flex: d.other, background: "#9ca3af" }} /></>}
                                  </div>
                                </div>
                                <span style={{ textAlign: "right", color: "#6b7280", fontSize: 10, fontWeight: 900, whiteSpace: "nowrap" }}>{deductPct}%</span>
                              </div>
                            );
                          })()}
                        </button>

                        {expandedPart && (
                          <div
                            style={{
                              padding: "8px 10px 10px",
                              borderTop: "1px solid #f1f5f9",
                            }}
                          >
                            {part.missingCount > 0 && (
                              <div
                                style={{
                                  color: "#92400e",
                                  fontSize: 10,
                                  fontWeight: 900,
                                  whiteSpace: "nowrap",
                                  marginBottom: 6,
                                }}
                              >
                                {MONTHLY_SIGNAL_EMOJIS.missingPrice}{" "}
                                {labels.missingUnitPrice}
                              </div>
                            )}

                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 7,
                              }}
                            >
                              {part.categories.map((category) => {
                              const categoryBarWidth =
                                maxCategoryAmount > 0
                                  ? (category.totalAmount / maxCategoryAmount) * 100
                                  : 0;
                              const categoryShare =
                                part.totalAmount > 0
                                  ? (category.totalAmount / part.totalAmount) * 100
                                  : 0;

                              return (
                                <div key={category.key} style={{ minWidth: 0 }}>
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      alignItems: "baseline",
                                      gap: 8,
                                      marginBottom: 3,
                                    }}
                                  >
                                    <span
                                      style={{
                                        minWidth: 0,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                        color: "#374151",
                                        fontSize: 11,
                                        fontWeight: 900,
                                      }}
                                    >
                                      {category.label}
                                      {category.missingCount > 0 && (
                                        <span
                                          style={{
                                            marginLeft: 4,
                                            color: "#92400e",
                                            fontSize: 10,
                                          }}
                                        >
                                          {MONTHLY_SIGNAL_EMOJIS.missingPrice}
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      style={{
                                        flexShrink: 0,
                                        color: "#111827",
                                        fontSize: 11,
                                        fontWeight: 900,
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {formatMoney(category.totalAmount, labels.priceNotSet)}
                                    </span>
                                  </div>

                                  <div
                                    style={{
                                      display: "grid",
                                      gridTemplateColumns: "minmax(0, 1fr) 38px",
                                      alignItems: "center",
                                      gap: 6,
                                    }}
                                  >
                                    <div
                                      style={{
                                        height: 5,
                                        overflow: "hidden",
                                        borderRadius: 999,
                                        background: "#e5e7eb",
                                      }}
                                    >
                                      <div
                                        style={{
                                          width: `${categoryBarWidth}%`,
                                          height: "100%",
                                          borderRadius: 999,
                                          background: "#2563eb",
                                        }}
                                      />
                                    </div>
                                    <span
                                      style={{
                                        textAlign: "right",
                                        color: "#6b7280",
                                        fontSize: 10,
                                        fontWeight: 900,
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {categoryShare.toFixed(1)}%
                                    </span>
                                  </div>
                                  {(() => {
                                    const cd = categoryDeductionData.get(`${part.key}:${category.key}`) ?? { sale: 0, check: 0, service: 0, other: 0, total: 0 };
                                    const barWidth = part.totalAmount > 0 ? (cd.total / part.totalAmount) * 100 : 0;
                                    return (
                                      <div style={{ height: 4, borderRadius: 999, overflow: "hidden", background: "#e5e7eb", marginTop: 3 }}>
                                        <div style={{ width: `${barWidth}%`, height: "100%", display: "flex" }}>
                                          {cd.total > 0 && <><div style={{ flex: cd.sale, background: "#ef4444" }} /><div style={{ flex: cd.check, background: "seagreen" }} /><div style={{ flex: cd.service, background: "#8b5cf6" }} /><div style={{ flex: cd.other, background: "#9ca3af" }} /></>}
                                        </div>
                                      </div>
                                    );
                                  })()}
                                </div>
                              );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </>
      ) : null}
    </Container>
  );
}
