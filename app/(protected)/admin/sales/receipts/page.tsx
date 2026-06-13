"use client";

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import SubNav from "@/components/SubNav";
import { getBusinessDate } from "@/lib/common/business-time";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import { getUser } from "@/lib/supabase/auth";
import { commonText, salesText } from "@/lib/text";

const salesTabs = [
  { href: "/admin/sales", key: "daily" },
  { href: "/admin/sales/receipts", key: "receipts" },
  { href: "/admin/sales/monthly", key: "monthly" },
] as const;

type SalesReceiptsText =
  (typeof salesText)[keyof typeof salesText]["receipts"];
type SalesReceiptsEditText =
  (typeof salesText)[keyof typeof salesText]["receiptsEdit"];
type SalesCommonText = (typeof salesText)[keyof typeof salesText]["common"];
type CommonText = (typeof commonText)[keyof typeof commonText];
type SalesReceiptsViewText = SalesCommonText &
  SalesReceiptsText &
  Pick<
    CommonText,
    | "quantity"
    | "total"
    | "loading"
    | "error"
    | "loadFailed"
    | "cash"
    | "transfer"
    | "card"
    | "paymentMethod"
    | "vat"
    | "totalTax"
    | "receivedAmount"
    | "changeAmount"
    | "paid"
    | "canceled"
    | "status"
    | "modified"
    | "table"
  > & {
    other: CommonText["etc"];
  };
type SalesReceiptsEditViewText = SalesCommonText &
  SalesReceiptsEditText &
  Pick<
    CommonText,
    | "quantity"
    | "delete"
    | "save"
    | "saving"
    | "cancel"
    | "reset"
    | "searchLoading"
    | "noSearchResult"
    | "cash"
    | "transfer"
    | "card"
    | "paymentMethod"
    | "vat"
    | "receivedAmount"
    | "changeAmount"
    | "manage"
    | "restore"
    | "add"
    | "productName"
    | "unitPrice"
    | "taxRate"
    | "taxAmount"
  > & {
    other: CommonText["etc"];
  };

type SalesReceiptsResponse = {
  ok: boolean;
  businessDate?: string;
  error?: string;
  receipts?: ReceiptItem[];
};

type ReceiptItem = {
  id: number;
  refId: string;
  refNo: string | null;
  refDate: string | null;
  tableName?: string | null;
  paymentStatus: number | null;
  isCanceled: boolean;
  totalAmount: number;
  finalAmount: number;
  isModified: boolean;
  reviewStatus: string | null;
  adminNote: string | null;
  lineCount: number;
  optionLineCount: number;
  payments?: ReceiptPayment[];
};

type ReceiptPayment = {
  paymentName: string | null;
  cardName: string | null;
  amount: number;
};

type ReceiptDetailResponse = {
  ok: boolean;
  error?: string;
  hasOptionLines?: boolean;
  receipt?: ReceiptDetail;
  payments?: PaymentDetail[];
  taxSummary?: TaxSummary;
  adjustedTaxSummary?: TaxSummary;
  lines?: LineDetail[];
};

type AmountSummarySnapshot = {
  totalAmount: number;
  vatAmount: number;
  finalAmount: number;
  paymentTotalAmount: number;
};

type ReceiptDetail = {
  id: number;
  refId: string;
  refNo: string | null;
  businessDate: string;
  refDate: string | null;
  paymentStatus: number | null;
  isCanceled: boolean;
  totalAmount: number;
  discountAmount: number;
  vatAmount: number;
  finalAmount: number;
  receiveAmount: number | null;
  returnAmount: number | null;
  customerName: string | null;
  tableName: string | null;
  isModified: boolean;
  modifiedAt: string | null;
  modifiedBy: string | null;
  modificationNote: string | null;
  reviewStatus: string | null;
  adminNote: string | null;
  originalAmountSummary: AmountSummarySnapshot | null;
};

type PaymentDetail = {
  id: number;
  paymentType: number | null;
  paymentName: string | null;
  cardName: string | null;
  amount: number;
};

type TaxSummary = {
  totalTaxAmount: number;
  taxSavingAmount?: number;
  amountDifferenceAmount?: number;
  taxByRate: {
    taxRate: number;
    taxAmount: number;
    lineCount: number;
  }[];
};

type LineDetail = {
  id: number;
  refDetailId: string | null;
  parentRefDetailId: string | null;
  sortOrder: number | null;
  itemCode: string | null;
  itemName: string | null;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
  discountAmount: number;
  finalAmount: number;
  taxRate: number;
  taxAmount: number;
  preTaxAmount: number;
  taxReductionAmount: number;
  refDetailType: number | null;
  inventoryItemType: number | null;
  isOption: boolean;
  mappingStatus: string | null;
  isExcluded: boolean;
  adminNote: string | null;
};

type ReceiptPatchResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  error?: string;
  receipt?: {
    id: number;
    totalAmount: number;
    finalAmount: number;
    receiveAmount: number | null;
    returnAmount: number | null;
    isModified: boolean;
    modifiedAt: string | null;
    modifiedBy: string | null;
    modificationNote: string | null;
  };
};

type SaveReceiptEditInput = {
  receiptId: number;
  lines: ReceiptEditLine[];
  paymentMethod: PaymentMethod;
  cashReceivedAmount: number | null;
  note: string;
};

type PaymentMethod = "cash" | "other";

type ReceiptEditLine =
  | {
    id: number;
    mode: "update" | "delete";
    quantity?: number;
  }
  | {
    mode: "create";
    clientId: string;
    parentClientId: string | null;
    productId: number | null;
    itemCode: string | null;
    itemName: string;
    unitName: string | null;
    unitPrice: number;
    quantity: number;
    taxRate: number | null;
    taxRateSource: string | null;
    isOption: boolean;
    refDetailType: number;
    inventoryItemType: number | null;
    additionId: string | null;
    optionGroupName: string | null;
    rawJson: Record<string, unknown> | null;
  };

type ReceiptDraftLine = {
  id: number;
  refDetailId: string | null;
  itemName: string;
  unitName: string | null;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  finalAmount: number;
  taxRate: number;
  mode: "update" | "delete";
};

type NewDraftLine = {
  mode: "create";
  clientId: string;
  parentClientId: string | null;
  productId: number | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  unitPrice: number;
  quantity: number;
  taxRate: number | null;
  taxRateSource: string | null;
  isOption: boolean;
  refDetailType: number;
  inventoryItemType: number | null;
  additionId: string | null;
  optionGroupName: string | null;
  rawJson: Record<string, unknown> | null;
};

type PosProductOption = {
  id: string;
  name: string;
  code: string | null;
  unitPrice: number;
  taxRate: number | null;
  raw: Record<string, unknown>;
};

type PosProductOptionGroup = {
  id: string;
  name: string;
  type: "addition" | "child";
  options: PosProductOption[];
};

type PosProduct = {
  id: number;
  source: string;
  branchId?: string | null;
  posItemId?: string | null;
  itemId: string | null;
  itemCode: string | null;
  itemName: string;
  itemNameVi?: string | null;
  categoryName?: string | null;
  unitName: string | null;
  unitPrice: number;
  priceIncludesVat?: boolean | null;
  taxRate?: number | null;
  taxName?: string | null;
  taxRateSource?: string | null;
  taxRateUpdatedAt?: string | null;
  itemType?: number | null;
  isActive: boolean;
  optionGroups?: PosProductOptionGroup[];
};

type PosProductsResponse = {
  ok: boolean;
  error?: string;
  products?: PosProduct[];
};

function isExistingOptionLine(line: LineDetail) {
  return (
    line.isOption ||
    Boolean(line.parentRefDetailId) ||
    line.refDetailType !== 1 ||
    line.mappingStatus === "option"
  );
}

type PosProductsSyncResponse = {
  ok: boolean;
  error?: string;
  result?: {
    totalFromApi?: number;
    fetchedCount?: number;
    detailRequestedCount?: number;
    detailFailedCount?: number;
    failedDetails?: unknown[];
    insertedCount?: number;
    updatedCount?: number;
    upsertedCount?: number;
    skippedCount?: number;
    taxInfoStatus?: string;
  };
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

function toFiniteNumber(value: number | string | null | undefined) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function calculateLineFinalAmount(params: {
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
}) {
  return params.quantity * params.unitPrice - (params.discountAmount || 0);
}

function calculateLineTaxAmount(
  finalAmount: number,
  taxRate: number | null | undefined
) {
  const rate = toFiniteNumber(taxRate);
  if (!Number.isFinite(finalAmount) || finalAmount <= 0 || rate <= 0) return 0;
  return Math.round((finalAmount * rate) / 100);
}

function formatTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";

  return date.toLocaleTimeString("ko-KR", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getPaymentStatusLabel(
  receipt: Pick<ReceiptItem, "isCanceled" | "paymentStatus" | "isModified">,
  text: SalesReceiptsViewText
) {
  if (receipt.isCanceled) return text.canceled;
  if (receipt.isModified) return text.modified;
  if (receipt.paymentStatus === 3) return text.paid;
  if (receipt.paymentStatus === 4 || receipt.paymentStatus === 5) {
    return text.canceled;
  }
  return `${text.status} ${receipt.paymentStatus ?? "-"}`;
}

function normalizePaymentText(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getPaymentLabel(
  payment: {
    paymentName?: string | null;
    payment_name?: string | null;
    cardName?: string | null;
    card_name?: string | null;
    paymentType?: number | string | null;
    payment_type?: number | string | null;
  },
  text: {
    cash?: string;
    transfer?: string;
    card?: string;
    other?: string;
  }
) {
  const rawName =
    payment.paymentName ??
    payment.payment_name ??
    payment.cardName ??
    payment.card_name ??
    "";

  const normalized = normalizePaymentText(rawName);
  const paymentType = String(payment.paymentType ?? payment.payment_type ?? "");

  if (
    normalized.includes("tien mat") ||
    normalized.includes("cash") ||
    paymentType === "1"
  ) {
    return text.cash ?? "현금";
  }

  if (
    normalized.includes("chuyen khoan") ||
    normalized.includes("transfer") ||
    normalized.includes("bank")
  ) {
    return text.transfer ?? "이체";
  }

  if (
    normalized.includes("the") ||
    normalized.includes("card") ||
    normalized.includes("visa") ||
    normalized.includes("master")
  ) {
    return text.card ?? "카드";
  }

  if (
    normalized.includes("khac") ||
    normalized.includes("other")
  ) {
    return text.other ?? "기타";
  }

  return String(rawName || text.other || "기타");
}

function isCashPayment(payment: Pick<ReceiptPayment, "paymentName" | "cardName">) {
  const paymentName = normalizePaymentText(payment.paymentName);
  const cardName = normalizePaymentText(payment.cardName);
  const label = `${paymentName} ${cardName}`;

  return (
    label.includes("tien mat") ||
    label.includes("cash")
  );
}

function getPaymentKindLabel(
  payment: Pick<ReceiptPayment, "paymentName" | "cardName">,
  text: SalesReceiptsViewText
) {
  const paymentName = normalizePaymentText(payment.paymentName);
  const cardName = normalizePaymentText(payment.cardName);
  const label = `${paymentName} ${cardName}`.trim();

  if (label.includes("tien mat") || label.includes("cash")) {
    return text.cash;
  }

  if (
    label.includes("chuyen khoan") ||
    label.includes("transfer") ||
    label.includes("bank")
  ) {
    return text.transfer;
  }

  if (label.includes("khac") || label.includes("other")) {
    return text.other;
  }

  if (
    label.includes("the") ||
    label.includes("card") ||
    label.includes("visa") ||
    label.includes("master") ||
    cardName
  ) {
    return text.card;
  }

  return payment.cardName || payment.paymentName || text.paymentMethod;
}

function getPaymentSummaryText(
  payments: ReceiptPayment[] | undefined,
  text: SalesReceiptsViewText
) {
  const labels = (payments || [])
    .map((payment) => getPaymentKindLabel(payment, text))
    .filter(Boolean);

  return Array.from(new Set(labels)).join(" · ");
}

function getPaymentIcon(payment: PaymentDetail) {
  const label = normalizePaymentText(
    `${payment.paymentName ?? ""} ${payment.cardName ?? ""}`
  );

  if (label.includes("tien mat") || label.includes("cash")) {
    return "💵";
  }

  if (
    label.includes("chuyen khoan") ||
    label.includes("transfer") ||
    label.includes("bank")
  ) {
    return "🏦";
  }

  if (
    label.includes("the") ||
    label.includes("card") ||
    label.includes("visa") ||
    label.includes("master")
  ) {
    return "💳";
  }

  if (label.includes("khac") || label.includes("other")) {
    return "💰";
  }

  return "💰";
}

function hasCashPayment(payments?: PaymentDetail[]) {
  return (payments || []).some(isCashPayment);
}

export default function SalesReceiptsPage() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { lang } = useLanguage();
  const t = salesText[lang];
  const c = commonText[lang];
  const s = t.common;
  const receiptsText = {
    ...s,
    ...t.receipts,
    quantity: c.quantity,
    total: c.total,
    loading: c.loading,
    error: c.error,
    loadFailed: c.loadFailed,
    cash: c.cash,
    transfer: c.transfer,
    card: c.card,
    other: c.etc,
    paymentMethod: c.paymentMethod,
    vat: c.vat,
    totalTax: c.totalTax,
    receivedAmount: c.receivedAmount,
    changeAmount: c.changeAmount,
    paid: c.paid,
    canceled: c.canceled,
    status: c.status,
    modified: c.modified,
    table: c.table,
  };
  const receiptsEditText = {
    ...s,
    ...t.receiptsEdit,
    quantity: c.quantity,
    delete: c.delete,
    save: c.save,
    saving: c.saving,
    cancel: c.cancel,
    reset: c.reset,
    searchLoading: c.searchLoading,
    noSearchResult: c.noSearchResult,
    cash: c.cash,
    transfer: c.transfer,
    card: c.card,
    other: c.etc,
    paymentMethod: c.paymentMethod,
    vat: c.vat,
    receivedAmount: c.receivedAmount,
    changeAmount: c.changeAmount,
    manage: c.manage,
    restore: c.restore,
    add: c.add,
    productName: c.productName,
    unitPrice: c.unitPrice,
    taxRate: c.taxRate,
    taxAmount: c.taxAmount,
  };
  const initialBusinessDate = searchParams.get("businessDate") || getBusinessDate();
  const [businessDate, setBusinessDate] = useState(initialBusinessDate);
  const [receipts, setReceipts] = useState<ReceiptItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [expandedReceiptId, setExpandedReceiptId] = useState<number | null>(null);
  const [detailByReceiptId, setDetailByReceiptId] = useState<
    Record<number, ReceiptDetailResponse>
  >({});
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null);
  const [detailErrorByReceiptId, setDetailErrorByReceiptId] = useState<
    Record<number, string>
  >({});
  const [editSavingId, setEditSavingId] = useState<number | null>(null);
  const [editErrorByReceiptId, setEditErrorByReceiptId] = useState<
    Record<number, string>
  >({});
  const [currentUser, setCurrentUser] =
    useState<ReturnType<typeof getUser>>(null);
  const [isMenuSyncing, setIsMenuSyncing] = useState(false);
  const [menuSyncMessage, setMenuSyncMessage] = useState("");
  const [menuSyncWarning, setMenuSyncWarning] = useState("");
  const [menuSyncErrorMessage, setMenuSyncErrorMessage] = useState("");

  const canSyncMenu =
    currentUser?.role === "owner" ||
    currentUser?.role === "master" ||
    currentUser?.role === "manager";

  const tabs = useMemo(
    () =>
      salesTabs.map((tab) => ({
        label: t.tabs[tab.key],
        href: `${tab.href}?businessDate=${encodeURIComponent(businessDate)}`,
        active:
          tab.href === "/admin/sales"
            ? pathname === "/admin/sales" || pathname === "/admin/sales/"
            : pathname.startsWith(tab.href),
      })),
    [businessDate, pathname, t.tabs]
  );

  useEffect(() => {
    setCurrentUser(getUser());
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchReceipts() {
      setIsLoading(true);
      setErrorMessage("");

      try {
        const query = `?businessDate=${encodeURIComponent(businessDate)}`;
        const res = await fetch(`/api/admin/sales/receipts${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await res.json()) as SalesReceiptsResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || receiptsText.loadFailed);
        }

        setReceipts(result.receipts || []);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setErrorMessage(
          error instanceof Error
            ? error.message
            : receiptsText.loadFailed
        );
        setReceipts([]);
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    setExpandedReceiptId(null);
    setDetailErrorByReceiptId({});
    fetchReceipts();

    return () => controller.abort();
  }, [businessDate, receiptsText.loadFailed]);

  async function handleToggleReceipt(receiptId: number) {
    if (expandedReceiptId === receiptId) {
      setExpandedReceiptId(null);
      return;
    }

    setExpandedReceiptId(receiptId);

    if (detailByReceiptId[receiptId]) return;

    setDetailLoadingId(receiptId);
    setDetailErrorByReceiptId((current) => ({ ...current, [receiptId]: "" }));

    try {
      const res = await fetch(`/api/admin/sales/receipts/${receiptId}`, {
        cache: "no-store",
      });
      const result = (await res.json()) as ReceiptDetailResponse;

      if (!res.ok || !result.ok) {
        throw new Error(result.error || receiptsText.detailLoadFailed);
      }

      setDetailByReceiptId((current) => ({
        ...current,
        [receiptId]: result,
      }));
    } catch (error) {
      setDetailErrorByReceiptId((current) => ({
        ...current,
        [receiptId]:
          error instanceof Error
            ? error.message
            : receiptsText.detailLoadFailed,
      }));
    } finally {
      setDetailLoadingId(null);
    }
  }

  async function handleSaveReceiptEdit({
    receiptId,
    lines,
    paymentMethod,
    cashReceivedAmount,
    note,
  }: SaveReceiptEditInput) {
    const user = getUser();

    if (!user?.username) {
      setEditErrorByReceiptId((current) => ({
        ...current,
        [receiptId]: c.loginAgain,
      }));
      return;
    }

    setEditSavingId(receiptId);
    setEditErrorByReceiptId((current) => ({
      ...current,
      [receiptId]: "",
    }));

    try {
      const res = await fetch(`/api/admin/sales/receipts/${receiptId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actorUsername: user.username,
          paymentMethod,
          cashReceivedAmount,
          note,
          lines,
        }),
      });

      const result = (await res.json()) as ReceiptPatchResponse;

      if (!res.ok || !result.ok || !result.receipt) {
        throw new Error(
          result.code === "receipt_has_option_lines"
            ? receiptsEditText.optionEditProtected
            : result.message || result.error || receiptsEditText.saveFailed
        );
      }

      const updatedReceipt = result.receipt;

      setReceipts((current) =>
        current.map((receipt) =>
          receipt.id === receiptId
            ? {
              ...receipt,
              totalAmount: updatedReceipt.totalAmount,
              finalAmount: updatedReceipt.finalAmount,
              isModified: updatedReceipt.isModified,
            }
            : receipt
        )
      );

      setDetailByReceiptId((current) => {
        const currentDetail = current[receiptId];

        if (!currentDetail?.receipt) return current;

        return {
          ...current,
          [receiptId]: {
            ...currentDetail,
            receipt: {
              ...currentDetail.receipt,
              totalAmount: updatedReceipt.totalAmount,
              finalAmount: updatedReceipt.finalAmount,
              receiveAmount: updatedReceipt.receiveAmount,
              returnAmount: updatedReceipt.returnAmount,
              isModified: updatedReceipt.isModified,
              modifiedAt: updatedReceipt.modifiedAt,
              modifiedBy: updatedReceipt.modifiedBy,
              modificationNote: updatedReceipt.modificationNote,
            },
          },
        };
      });

      const refreshed = await fetch(`/api/admin/sales/receipts/${receiptId}`, {
        cache: "no-store",
      });
      const refreshedDetail = (await refreshed.json()) as ReceiptDetailResponse;

      if (refreshed.ok && refreshedDetail.ok) {
        setDetailByReceiptId((current) => ({
          ...current,
          [receiptId]: refreshedDetail,
        }));
        setReceipts((current) =>
          current.map((receipt) =>
            receipt.id === receiptId && refreshedDetail.receipt
              ? {
                ...receipt,
                totalAmount: refreshedDetail.receipt.totalAmount,
                finalAmount: refreshedDetail.receipt.finalAmount,
                isModified: refreshedDetail.receipt.isModified,
                payments: (refreshedDetail.payments || []).map((payment) => ({
                  paymentName: payment.paymentName,
                  cardName: payment.cardName,
                  amount: payment.amount,
                })),
                lineCount: (refreshedDetail.lines || []).filter(
                  (line) => !isExistingOptionLine(line)
                ).length,
                optionLineCount: (refreshedDetail.lines || []).filter(
                  isExistingOptionLine
                ).length,
              }
              : receipt
          )
        );
      }
    } catch (error) {
      setEditErrorByReceiptId((current) => ({
        ...current,
        [receiptId]:
          error instanceof Error ? error.message : receiptsEditText.saveFailed,
      }));
    } finally {
      setEditSavingId(null);
    }
  }

  function handleBusinessDateChange(value: string) {
    setBusinessDate(value);
    setDetailByReceiptId({});
    setEditErrorByReceiptId({});
    router.replace(`${pathname}?businessDate=${encodeURIComponent(value)}`, {
      scroll: false,
    });
  }

  async function handleSyncMenu() {
    if (!currentUser?.username || !canSyncMenu) {
      setMenuSyncErrorMessage(receiptsText.noPermission);
      setMenuSyncMessage("");
      setMenuSyncWarning("");
      return;
    }

    setIsMenuSyncing(true);
    setMenuSyncMessage("");
    setMenuSyncWarning("");
    setMenuSyncErrorMessage("");

    try {
      const res = await fetch("/api/admin/pos/products/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          actorUsername: currentUser.username,
        }),
      });
      const result = (await res.json().catch(() => null)) as
        | PosProductsSyncResponse
        | null;

      if (!res.ok || !result?.ok) {
        throw new Error(
          res.status === 403
            ? receiptsText.noPermission
            : receiptsText.menuSyncFailed
        );
      }

      const upsertedCount = result.result?.upsertedCount || 0;
      const detailFailedCount = result.result?.detailFailedCount || 0;

      setMenuSyncMessage(
        `${receiptsText.menuSyncSuccess}: ${receiptsText.menuSyncApplied} ${formatNumber(upsertedCount)}${receiptsText.menuSyncCountSuffix}, ${receiptsText.menuSyncDetailFailed} ${formatNumber(detailFailedCount)}${receiptsText.menuSyncCountSuffix}`
      );
      setMenuSyncWarning(
        detailFailedCount > 0 ? receiptsText.menuSyncDetailWarning : ""
      );
    } catch (error) {
      setMenuSyncErrorMessage(
        error instanceof Error ? error.message : receiptsText.menuSyncFailed
      );
    } finally {
      setIsMenuSyncing(false);
    }
  }

  return (
    <Container noPaddingTop>
      <SubNav tabs={tabs} />

      <div style={sectionStyle}>
        <section style={noticeCardStyle}>
          <div style={noticeHeaderStyle}>
            <span style={noticeBadgeStyle}>{receiptsText.badge}</span>
            <span style={noticeTitleStyle}>{receiptsText.title}</span>
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
            {canSyncMenu ? (
              <div style={menuSyncWrapStyle}>
                <span style={menuSyncDescriptionStyle}>
                  {receiptsText.menuSyncDescription}
                </span>
                <button
                  type="button"
                  onClick={handleSyncMenu}
                  disabled={isMenuSyncing}
                  style={{
                    ...menuSyncButtonStyle,
                    ...(isMenuSyncing ? menuSyncButtonDisabledStyle : null),
                  }}
                >
                  {isMenuSyncing
                    ? receiptsText.menuSyncing
                    : receiptsText.menuSyncButton}
                </button>
              </div>
            ) : null}
          </div>
          {menuSyncMessage ? (
            <p style={successTextStyle}>{menuSyncMessage}</p>
          ) : null}
          {menuSyncWarning ? (
            <p style={warningTextStyle}>{menuSyncWarning}</p>
          ) : null}
          {menuSyncErrorMessage ? (
            <p style={errorTextStyle}>{menuSyncErrorMessage}</p>
          ) : null}
          {errorMessage ? <p style={errorTextStyle}>{errorMessage}</p> : null}
        </section>

        <section style={cardStyle}>
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>{receiptsText.listTitle}</h2>
            <span style={sectionMetaStyle}>
              {receipts.length}{receiptsText.receiptCountSuffix}
            </span>
          </div>

          <ReceiptList
            isLoading={isLoading}
            text={receiptsText}
            editText={receiptsEditText}
            receipts={receipts}
            expandedReceiptId={expandedReceiptId}
            detailByReceiptId={detailByReceiptId}
            detailLoadingId={detailLoadingId}
            detailErrorByReceiptId={detailErrorByReceiptId}
            editSavingId={editSavingId}
            editErrorByReceiptId={editErrorByReceiptId}
            onToggleReceipt={handleToggleReceipt}
            onSaveEdit={handleSaveReceiptEdit}
          />
        </section>
      </div>
    </Container>
  );
}

function ReceiptList({
  isLoading,
  text,
  editText,
  receipts,
  expandedReceiptId,
  detailByReceiptId,
  detailLoadingId,
  detailErrorByReceiptId,
  editSavingId,
  editErrorByReceiptId,
  onToggleReceipt,
  onSaveEdit,
}: {
  isLoading: boolean;
  text: SalesReceiptsViewText;
  editText: SalesReceiptsEditViewText;
  receipts: ReceiptItem[];
  expandedReceiptId: number | null;
  detailByReceiptId: Record<number, ReceiptDetailResponse>;
  detailLoadingId: number | null;
  detailErrorByReceiptId: Record<number, string>;
  editSavingId: number | null;
  editErrorByReceiptId: Record<number, string>;
  onToggleReceipt: (receiptId: number) => void;
  onSaveEdit: (input: SaveReceiptEditInput) => void;
}) {
  if (isLoading) {
    return (
      <EmptyState
        title={text.loading}
        text={text.detailLoading}
      />
    );
  }

  if (receipts.length === 0) {
    return (
      <EmptyState
        title={text.noReceipts}
        text={text.selectedBusinessDateNoReceipts}
      />
    );
  }

  return (
    <div style={receiptListStyle}>
      {receipts.map((receipt, index) => {
        const isExpanded = expandedReceiptId === receipt.id;

        return (
          <div
            key={receipt.id}
            style={{
              ...receiptItemWrapStyle,
              ...(index % 2 === 1 ? receiptItemAlternateStyle : null),
              ...(isExpanded ? receiptItemExpandedStyle : null),
            }}
          >
            <ReceiptRow
              text={text}
              receipt={receipt}
              isExpanded={isExpanded}
              onToggle={() => onToggleReceipt(receipt.id)}
            />
            {isExpanded ? (
              <ReceiptDropdown
                text={text}
                editText={editText}
                detail={detailByReceiptId[receipt.id]}
                isLoading={detailLoadingId === receipt.id}
                errorMessage={detailErrorByReceiptId[receipt.id] || ""}
                isEditSaving={editSavingId === receipt.id}
                editErrorMessage={editErrorByReceiptId[receipt.id] || ""}
                onSaveEdit={onSaveEdit}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ReceiptRow({
  text,
  receipt,
  isExpanded,
  onToggle,
}: {
  text: SalesReceiptsViewText;
  receipt: ReceiptItem;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const statusLabel = getPaymentStatusLabel(receipt, text);
  const paymentSummaryText = getPaymentSummaryText(receipt.payments, text);

  return (
    <button type="button" onClick={onToggle} style={receiptRowButtonStyle}>
      <span style={receiptMainStyle}>
        <span style={receiptTopLineStyle}>
          <strong style={receiptNoStyle}>
            {text.table}: {receipt.tableName || "-"}
          </strong>
          <span
            style={{
              ...statusBadgeStyle,
              ...(receipt.isCanceled
                ? canceledBadgeStyle
                : receipt.isModified
                  ? modifiedBadgeStyle
                  : paidBadgeStyle),
            }}
          >
            {statusLabel}
          </span>
        </span>
        <span style={receiptMetaLineStyle}>
          {receipt.refNo || receipt.refId}
          {paymentSummaryText ? ` · ${paymentSummaryText}` : ""}
        </span>
        <span style={receiptMetaLineStyle}>
          {text.salesItems} {formatNumber(receipt.lineCount)}{text.productCountSuffix} · {text.optionItems}{" "}
          {formatNumber(receipt.optionLineCount)}{text.optionCountSuffix}
        </span>
      </span>

      <span style={receiptAmountWrapStyle}>
        <span style={receiptTimeStyle}>{formatTime(receipt.refDate)}</span>
        <strong style={amountStyle}>{formatVnd(receipt.finalAmount)}</strong>
        <span style={chevronStyle}>{isExpanded ? "⌃" : "⌄"}</span>
      </span>
    </button>
  );
}

function ReceiptDropdown({
  text,
  editText,
  detail,
  isLoading,
  errorMessage,
  isEditSaving,
  editErrorMessage,
  onSaveEdit,
}: {
  text: SalesReceiptsViewText;
  editText: SalesReceiptsEditViewText;
  detail?: ReceiptDetailResponse;
  isLoading: boolean;
  errorMessage: string;
  isEditSaving: boolean;
  editErrorMessage: string;
  onSaveEdit: (input: SaveReceiptEditInput) => void;
}) {
  if (isLoading) {
    return (
      <div style={dropdownStyle}>
        <EmptyState title={text.loading} text={text.detailLoading} />
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div style={dropdownStyle}>
        <EmptyState title={text.error} text={errorMessage} />
      </div>
    );
  }

  if (!detail?.receipt) {
    return null;
  }
  const receipt = detail.receipt;
  const payments = detail.payments || [];
  const hasOptionLines =
    detail.hasOptionLines === true ||
    (detail.lines || []).some(isExistingOptionLine);

  // ?먮낯 ?멸툑 ?쒖떆?? API??taxSummary??original_tax_summary / vat_amount 湲곗?
  const taxRows = detail.taxSummary?.taxByRate || [];
  const originalTotalTaxAmount = toFiniteNumber(
    detail.taxSummary?.totalTaxAmount ?? receipt.vatAmount
  );

  const taxSavingAmount = toFiniteNumber(detail.taxSummary?.taxSavingAmount);
  const amountDifferenceAmount = toFiniteNumber(
    detail.taxSummary?.amountDifferenceAmount
  );

  const showCashExtra =
    hasCashPayment(payments) &&
    (detail.receipt.receiveAmount !== null || detail.receipt.returnAmount !== null);

  return (
    <div style={dropdownStyle}>
      <DetailSection title={text.salesItems}>
        <div style={lineListStyle}>
          {(detail.lines || []).map((line) => {
            const isOption = isExistingOptionLine(line);
            const lineTotalAmount = line.finalAmount || line.amount;

            return (
              <div
                key={line.id}
                style={{
                  ...lineRowStyle,
                  ...(isOption ? optionLineRowStyle : null),
                }}
              >
                <div style={lineTitleRowStyle}>
                  <span
                    style={{
                      ...lineNameStyle,
                      ...(isOption ? optionLineNameStyle : null),
                    }}
                  >
                    {line.itemName || "-"}
                  </span>
                  {isOption ? <span style={optionBadgeStyle}>{text.optionItems}</span> : null}
                </div>
                <span
                  style={{
                    ...lineSummaryStyle,
                    ...(isOption ? optionLineSummaryStyle : null),
                  }}
                >
                  <span>{text.quantity} {formatNumber(line.quantity)}</span>
                  <strong style={lineSummaryAmountStyle}>
                    {formatVnd(lineTotalAmount)}
                  </strong>
                </span>
              </div>
            );
          })}
        </div>
      </DetailSection>

      <DetailSection title={text.total}>
        <div style={miniListStyle}>
          <div style={miniRowStyle}>
            <span style={miniLabelStyle}>{text.salesAmount}</span>
            <strong style={miniValueStyle}>{formatVnd(detail.receipt.totalAmount)}</strong>
          </div>
          <div style={miniRowStyle}>
            <span style={miniLabelStyle}>{text.totalTax}</span>
            <strong style={miniValueStyle}>{formatVnd(originalTotalTaxAmount)}</strong>
          </div>
          {taxRows.map((tax) => (
            <div key={tax.taxRate} style={miniRowStyle}>
              <span style={miniLabelStyle}>{text.vat} {formatNumber(tax.taxRate)}%</span>
              <strong style={miniValueStyle}>{formatVnd(tax.taxAmount)}</strong>
              <span style={lineCountStyle}>
                {formatNumber(tax.lineCount)}{text.productCountSuffix}
              </span>
            </div>
          ))}
          <div style={miniRowStyle}>
            <span style={miniLabelStyle}>{text.totalPaymentAmount}</span>
            <strong style={miniValueStyle}>{formatVnd(detail.receipt.finalAmount)}</strong>
          </div>
        </div>

        <div style={paymentBlockStyle}>
          <span style={paymentBlockTitleStyle}>{text.actualPaid}</span>
          {payments.length > 0 ? (
            <div style={miniListStyle}>
              {payments.map((payment) => (
                <div key={payment.id} style={miniRowStyle}>
                  <span style={miniLabelStyle}>
                    {getPaymentIcon(payment)} {getPaymentLabel(payment, text)}
                  </span>
                  <strong style={miniValueStyle}>{formatVnd(payment.amount)}</strong>
                </div>
              ))}
            </div>
          ) : (
            <p style={mutedTextStyle}>{text.noPaymentData}</p>
          )}
        </div>

        {showCashExtra ? (
          <div style={cashExtraStyle}>
            {detail.receipt.receiveAmount !== null ? (
              <div style={miniRowStyle}>
                <span style={miniLabelStyle}>{text.receivedAmount}</span>
                <strong style={miniValueStyle}>
                  {formatVnd(detail.receipt.receiveAmount ?? 0)}
                </strong>
              </div>
            ) : null}
            {detail.receipt.returnAmount !== null ? (
              <div style={miniRowStyle}>
                <span style={miniLabelStyle}>{text.changeAmount}</span>
                <strong style={miniValueStyle}>
                  {formatVnd(detail.receipt.returnAmount ?? 0)}
                </strong>
              </div>
            ) : null}
          </div>
        ) : null}
      </DetailSection>

      <ReceiptEditPanel
        key={`${receipt.id}-${receipt.modifiedAt || "original"}`}
        text={editText}
        receipt={receipt}
        lines={detail.lines || []}
        payments={payments}
        taxSavingAmount={taxSavingAmount}
        amountDifferenceAmount={amountDifferenceAmount}
        hasOptionLines={hasOptionLines}
        isSaving={isEditSaving}
        errorMessage={editErrorMessage}
        onSave={(values) =>
          onSaveEdit({
            receiptId: receipt.id,
            ...values,
          })
        }
      />
    </div>
  );
}

function ReceiptEditPanel({
  text,
  receipt,
  lines,
  payments,
  taxSavingAmount,
  amountDifferenceAmount,
  hasOptionLines,
  isSaving,
  errorMessage,
  onSave,
}: {
  text: SalesReceiptsEditViewText;
  receipt: ReceiptDetail;
  lines: LineDetail[];
  payments: PaymentDetail[];
  taxSavingAmount: number;
  amountDifferenceAmount: number;
  hasOptionLines: boolean;
  isSaving: boolean;
  errorMessage: string;
  onSave: (values: Omit<SaveReceiptEditInput, "receiptId">) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftLines, setDraftLines] = useState<ReceiptDraftLine[]>(() =>
    lines
      .filter((line) => !isExistingOptionLine(line))
      .map((line) => ({
        id: line.id,
        refDetailId: line.refDetailId,
        itemName: line.itemName || "",
        unitName: line.unitName,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
        finalAmount: line.finalAmount,
        taxRate: line.taxRate,
        mode: "update" as const,
      }))
  );
  const existingOptionLines = lines.filter(isExistingOptionLine);
  const [newLines, setNewLines] = useState<NewDraftLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    hasCashPayment(payments) ? "cash" : "other"
  );
  const [cashReceivedAmount, setCashReceivedAmount] = useState(
    receipt.receiveAmount ?? receipt.finalAmount
  );
  const [note, setNote] = useState(receipt.modificationNote || "");
  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<PosProduct[]>([]);
  const [productSearchError, setProductSearchError] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<PosProduct | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<
    Record<string, PosProductOption>
  >({});
  const [newProductQuantity, setNewProductQuantity] = useState(1);

  useEffect(() => {
    const query = productQuery.trim();
    const controller = new AbortController();

    if (!isEditing || query.length < 1) {
      setProductResults([]);
      setProductSearchError("");
      return () => controller.abort();
    }

    async function fetchProducts() {
      try {
        const res = await fetch(
          `/api/pos/products?query=${encodeURIComponent(query)}&includeOptions=1`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        const result = (await res.json()) as PosProductsResponse;

        if (!res.ok || !result.ok) {
          throw new Error(result.error || text.productSearchFailed);
        }

        setProductResults(result.products || []);
        setProductSearchError("");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setProductSearchError(
          error instanceof Error ? error.message : text.productSearchFailed
        );
        setProductResults([]);
      }
    }

    fetchProducts();
    return () => controller.abort();
  }, [isEditing, productQuery, text.productSearchFailed]);

  const activeDraftLineTotals = draftLines
    .filter((line) => line.mode !== "delete")
    .map((line) => ({
      finalAmount: calculateLineFinalAmount({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: line.discountAmount,
      }),
      taxRate: line.taxRate,
    }));
  const existingOptionLineTotals = existingOptionLines.flatMap((line) => {
    const parentLine = line.parentRefDetailId
      ? draftLines.find(
          (candidate) => candidate.refDetailId === line.parentRefDetailId
        )
      : null;

    if (parentLine?.mode === "delete") return [];

    return [
      {
        finalAmount: calculateLineFinalAmount({
          quantity: parentLine?.quantity ?? line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount,
        }),
        taxRate: line.taxRate,
      },
    ];
  });
  const newDraftLineTotals = newLines.map((line) => ({
    finalAmount: calculateLineFinalAmount({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    }),
    taxRate: line.taxRate,
  }));
  const draftLineTotals = [
    ...activeDraftLineTotals,
    ...existingOptionLineTotals,
    ...newDraftLineTotals,
  ];
  const draftSalesSubtotal = draftLineTotals.reduce(
    (sum, line) => sum + line.finalAmount,
    0
  );
  const draftAdjustedTaxAmount = draftLineTotals.reduce(
    (sum, line) => sum + calculateLineTaxAmount(line.finalAmount, line.taxRate),
    0
  );
  const draftPaymentTotal = draftSalesSubtotal + draftAdjustedTaxAmount;
  const returnAmount =
    paymentMethod === "cash"
      ? Math.max(0, cashReceivedAmount - draftPaymentTotal)
      : 0;
  const cashPaymentInvalid =
    paymentMethod === "cash" &&
    (!Number.isFinite(cashReceivedAmount) ||
      cashReceivedAmount < draftPaymentTotal);
  const saveDisabled = isSaving || draftSalesSubtotal <= 0 || cashPaymentInvalid;

  function updateLine(index: number, nextLine: Partial<ReceiptDraftLine>) {
    setDraftLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index ? { ...line, ...nextLine } : line
      )
    );
  }

  function removeLine(index: number) {
    setDraftLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index ? { ...line, mode: "delete" } : line
      )
    );
  }

  function restoreLine(index: number) {
    updateLine(index, { mode: "update" });
  }

  function addSelectedProduct() {
    if (!selectedProduct || newProductQuantity <= 0) return;

    const clientId = `manual-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const optionLines = Object.entries(selectedOptions).map(
      ([optionGroupId, option], optionIndex): NewDraftLine => ({
        mode: "create",
        clientId: `${clientId}-option-${optionIndex + 1}`,
        parentClientId: clientId,
        productId: null,
        itemCode: option.code,
        itemName: option.name,
        unitName: selectedProduct.unitName,
        unitPrice: option.unitPrice,
        quantity: newProductQuantity,
        taxRate: option.taxRate ?? selectedProduct.taxRate ?? null,
        taxRateSource: selectedProduct.taxRateSource ?? null,
        isOption: true,
        refDetailType: 2,
        inventoryItemType: 6,
        additionId: option.id,
        optionGroupName:
          selectedProduct.optionGroups?.find(
            (group) => group.id === optionGroupId
          )?.name ?? optionGroupId,
        rawJson: option.raw,
      })
    );

    setNewLines((current) => [
      ...current,
      {
        mode: "create",
        clientId,
        parentClientId: null,
        productId: selectedProduct.id,
        itemCode: selectedProduct.itemCode,
        itemName: selectedProduct.itemName,
        unitName: selectedProduct.unitName,
        unitPrice: selectedProduct.unitPrice,
        quantity: newProductQuantity,
        taxRate: selectedProduct.taxRate ?? null,
        taxRateSource: selectedProduct.taxRateSource ?? null,
        isOption: false,
        refDetailType: 1,
        inventoryItemType: selectedProduct.itemType ?? null,
        additionId: null,
        optionGroupName: null,
        rawJson: null,
      },
      ...optionLines,
    ]);
    setSelectedProduct(null);
    setSelectedOptions({});
    setProductQuery("");
    setProductResults([]);
    setNewProductQuantity(1);
  }

  function resetDraft() {
    setDraftLines(
      lines
        .filter((line) => !isExistingOptionLine(line))
        .map((line) => ({
          id: line.id,
          refDetailId: line.refDetailId,
          itemName: line.itemName || "",
          unitName: line.unitName,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountAmount: line.discountAmount,
          finalAmount: line.finalAmount,
          taxRate: line.taxRate,
          mode: "update" as const,
        }))
    );
    setNewLines([]);
    setPaymentMethod(hasCashPayment(payments) ? "cash" : "other");
    setCashReceivedAmount(receipt.receiveAmount ?? receipt.finalAmount);
    setNote(receipt.modificationNote || "");
    setSelectedProduct(null);
    setSelectedOptions({});
    setProductQuery("");
    setProductResults([]);
    setIsEditing(false);
  }

  function saveDraft() {
    const existingLines: ReceiptEditLine[] = draftLines.map((line) =>
      line.mode === "delete"
        ? {
          id: line.id,
          mode: "delete",
        }
        : {
          id: line.id,
          mode: "update",
          quantity: Number(line.quantity),
        }
    );
    const createLines: ReceiptEditLine[] = newLines.map((line) => ({
      ...line,
      quantity: Number(line.quantity),
    }));

    if ([...existingLines, ...createLines].length === 0) return;
    if (saveDisabled) return;

    onSave({
      lines: [...existingLines, ...createLines],
      paymentMethod,
      cashReceivedAmount: paymentMethod === "cash" ? cashReceivedAmount : null,
      note,
    });
  }

  return (
    <DetailSection title={text.manage}>
      <div style={editPanelStyle}>
        <div style={editSummaryStyle}>
          <strong style={miniValueStyle}>
            {text.taxSaving}:{" "}
            {formatVnd(taxSavingAmount)}
          </strong>
          <strong style={miniValueStyle}>
            {text.amountDifference}:{" "}
            {formatVnd(amountDifferenceAmount)}
          </strong>
          {isEditing ? (
            <span style={mutedTextStyle}>{text.taxRecalculateNotice}</span>
          ) : null}
        </div>

        {!isEditing ? (
          <>
            {hasOptionLines ? (
              <p style={mutedTextStyle}>{text.existingOptionReadOnlyNotice}</p>
            ) : null}
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              style={editButtonStyle}
            >
              {text.title}
            </button>
          </>
        ) : (
          <>
            {hasOptionLines ? (
              <p style={existingOptionNoticeStyle}>
                {text.existingOptionReadOnlyNotice}
              </p>
            ) : null}
            <div style={editLineListStyle}>
              {draftLines.map((line, index) => {
                const linkedOptions = line.refDetailId
                  ? existingOptionLines.filter(
                      (option) =>
                        option.parentRefDetailId === line.refDetailId
                    )
                  : [];

                return (
                  <div key={line.id} style={existingLineGroupStyle}>
                    <div
                      style={{
                        ...editLineRowStyle,
                        ...(line.mode === "delete"
                          ? deletedEditLineRowStyle
                          : null),
                      }}
                    >
                      <span style={editLineNameStyle}>{line.itemName}</span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={line.quantity}
                        onChange={(event) =>
                          updateLine(index, {
                            quantity: Math.max(
                              0,
                              Number(event.target.value)
                            ),
                          })
                        }
                        style={editNumberInputStyle}
                        disabled={isSaving || line.mode === "delete"}
                      />
                      <strong style={miniValueStyle}>
                        {formatVnd(
                          calculateLineFinalAmount({
                            quantity: line.quantity,
                            unitPrice: line.unitPrice,
                            discountAmount: line.discountAmount,
                          })
                        )}
                      </strong>
                      <button
                        type="button"
                        onClick={() =>
                          line.mode === "delete"
                            ? restoreLine(index)
                            : removeLine(index)
                        }
                        disabled={isSaving}
                        style={deleteLineButtonStyle}
                      >
                        {line.mode === "delete" ? text.restore : text.delete}
                      </button>
                    </div>
                    {linkedOptions.map((option) => {
                      const optionQuantity = line.quantity;
                      const optionFinalAmount = calculateLineFinalAmount({
                        quantity: optionQuantity,
                        unitPrice: option.unitPrice,
                        discountAmount: option.discountAmount,
                      });

                      return (
                        <div
                          key={option.id}
                          style={{
                            ...existingOptionReadOnlyRowStyle,
                            ...(line.mode === "delete"
                              ? deletedEditLineRowStyle
                              : null),
                          }}
                        >
                          <span style={editLineNameStyle}>
                            {text.optionItems} · {option.itemName}
                          </span>
                          <span style={existingOptionMetaStyle}>
                            {formatNumber(optionQuantity)}
                          </span>
                          <span style={existingOptionMetaStyle}>
                            {formatVnd(option.unitPrice)}
                          </span>
                          <strong style={miniValueStyle}>
                            {formatVnd(optionFinalAmount)}
                          </strong>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <div style={productSearchStyle}>
              <span style={reviewCurrentStatusStyle}>{text.addItem}</span>
              <input
                value={productQuery}
                onChange={(event) => setProductQuery(event.target.value)}
                placeholder={text.searchProductPlaceholder}
                style={editNameInputStyle}
                disabled={isSaving}
              />
              {productResults.length > 0 ? (
                <div style={productResultListStyle}>
                  {productResults.map((product) => (
                    <button
                      type="button"
                      key={product.id}
                      onClick={() => {
                        setSelectedProduct(product);
                        setSelectedOptions({});
                      }}
                      style={{
                        ...productResultButtonStyle,
                        ...(selectedProduct?.id === product.id
                          ? productResultButtonSelectedStyle
                          : null),
                      }}
                      onMouseEnter={(event) => {
                        event.currentTarget.style.background = "#111827";
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background =
                          selectedProduct?.id === product.id
                            ? "#111827"
                            : "#1f2937";
                      }}
                    >
                      <span style={productResultNameStyle}>{product.itemName}</span>
                      <strong style={productResultPriceStyle}>
                        {formatVnd(product.unitPrice)}
                      </strong>
                    </button>
                  ))}
                </div>
              ) : null}
              {productSearchError ? (
                <p style={reviewErrorTextStyle}>{productSearchError}</p>
              ) : null}
              {selectedProduct ? (
                <div style={selectedProductStyle}>
                  <div style={selectedProductHeaderStyle}>
                    <span style={editLineNameStyle}>
                      {selectedProduct.itemCode ? `${selectedProduct.itemCode} · ` : ""}
                      {selectedProduct.itemName} · {formatVnd(selectedProduct.unitPrice)}
                    </span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={newProductQuantity}
                      onChange={(event) =>
                        setNewProductQuantity(Math.max(0, Number(event.target.value)))
                      }
                      style={editNumberInputStyle}
                      disabled={isSaving}
                    />
                    <button
                      type="button"
                      onClick={addSelectedProduct}
                      disabled={isSaving || newProductQuantity <= 0}
                      style={secondaryButtonStyle}
                    >
                      {text.add}
                    </button>
                  </div>
                  {(selectedProduct.optionGroups || []).filter(
                    (group) => group.type === "addition"
                  ).length > 0 ? (
                    <div style={optionSelectionStyle}>
                      <span style={reviewCurrentStatusStyle}>
                        {text.selectOptions}
                      </span>
                      <span style={mutedTextStyle}>{text.optionsAvailable}</span>
                      {(selectedProduct.optionGroups || [])
                        .filter((group) => group.type === "addition")
                        .map((group) => (
                          <div key={group.id} style={optionGroupStyle}>
                            <strong style={miniValueStyle}>{group.name}</strong>
                            <div style={optionButtonListStyle}>
                              {group.options.map((option) => {
                                const selected =
                                  selectedOptions[group.id]?.id === option.id;

                                return (
                                  <button
                                    type="button"
                                    key={option.id}
                                    onClick={() =>
                                      setSelectedOptions((current) => {
                                        if (current[group.id]?.id === option.id) {
                                          const next = { ...current };
                                          delete next[group.id];
                                          return next;
                                        }

                                        return {
                                          ...current,
                                          [group.id]: option,
                                        };
                                      })
                                    }
                                    disabled={isSaving}
                                    style={{
                                      ...secondaryButtonStyle,
                                      ...optionButtonStyle,
                                      ...(selected ? activeSegmentStyle : null),
                                    }}
                                  >
                                    <span style={optionButtonNameStyle}>
                                      {option.name}
                                    </span>
                                    <span style={optionButtonPriceStyle}>
                                      {text.surcharge} {formatVnd(option.unitPrice)}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {newLines.length > 0 ? (
                <div style={editLineListStyle}>
                  {newLines.map((line, index) => (
                    <div
                      key={line.clientId}
                      style={{
                        ...newLineRowStyle,
                        ...(line.isOption ? newOptionLineRowStyle : null),
                      }}
                    >
                      <span style={editLineNameStyle}>
                        {line.isOption ? `${text.optionItems} · ` : ""}
                        {line.itemName}
                      </span>
                      <span style={reviewCurrentStatusStyle}>{formatNumber(line.quantity)}</span>
                      <strong style={miniValueStyle}>
                        {formatVnd(
                          calculateLineFinalAmount({
                            quantity: line.quantity,
                            unitPrice: line.unitPrice,
                          })
                        )}
                      </strong>
                      <button
                        type="button"
                        onClick={() =>
                          setNewLines((current) =>
                            current.filter(
                              (candidate, lineIndex) =>
                                lineIndex !== index &&
                                candidate.parentClientId !== line.clientId
                            )
                          )
                        }
                        style={deleteLineButtonStyle}
                      >
                        {text.delete}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div style={paymentEditBlockStyle}>
              <span style={reviewCurrentStatusStyle}>{text.paymentMethod}</span>
              <span style={paymentMethodButtonsStyle}>
                <button
                  type="button"
                  onClick={() => {
                    setPaymentMethod("cash");
                    setCashReceivedAmount((current) =>
                      Math.max(toFiniteNumber(current), draftPaymentTotal)
                    );
                  }}
                  style={{
                    ...secondaryButtonStyle,
                    ...(paymentMethod === "cash" ? activeSegmentStyle : null),
                  }}
                >
                  {text.cash}
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMethod("other")}
                  style={{
                    ...secondaryButtonStyle,
                    ...(paymentMethod === "other" ? activeSegmentStyle : null),
                  }}
                >
                  {text.other}
                </button>
              </span>
              {paymentMethod === "cash" ? (
                <div style={cashPaymentEditStyle}>
                  <label style={cashInputLabelStyle}>
                    <span style={reviewCurrentStatusStyle}>{text.receivedAmount}</span>
                    <input
                      type="number"
                      min={draftPaymentTotal}
                      step="1000"
                      value={cashReceivedAmount}
                      onChange={(event) =>
                        setCashReceivedAmount(Number(event.target.value))
                      }
                      style={editNameInputStyle}
                      disabled={isSaving}
                    />
                  </label>
                  <div style={miniRowStyle}>
                    <span style={miniLabelStyle}>{text.changeAmount}</span>
                    <strong style={miniValueStyle}>{formatVnd(returnAmount)}</strong>
                  </div>
                </div>
              ) : null}
            </div>

            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={text.memoPlaceholder}
              style={editTextareaStyle}
              disabled={isSaving}
            />

            <div style={reviewFooterStyle}>
              <span style={productResultMainStyle}>
                <span style={reviewCurrentStatusStyle}>
                  {text.salesAmount} {formatVnd(draftSalesSubtotal)} · {text.vat}{" "}
                  {formatVnd(draftAdjustedTaxAmount)}
                </span>
                <strong style={miniValueStyle}>{formatVnd(draftPaymentTotal)}</strong>
                {cashPaymentInvalid ? (
                  <span style={reviewErrorTextStyle}>
                    {text.finalAmountTooHigh}
                  </span>
                ) : null}
              </span>
              <span style={editActionGroupStyle}>
                <button type="button" onClick={resetDraft} disabled={isSaving} style={secondaryButtonStyle}>
                  {text.cancel}
                </button>
                <button
                  type="button"
                  onClick={saveDraft}
                  disabled={saveDisabled}
                  style={{
                    ...reviewSaveButtonStyle,
                    ...(saveDisabled ? reviewSaveButtonDisabledStyle : null),
                  }}
                >
                  {isSaving ? text.saving : text.save}
                </button>
              </span>
            </div>
          </>
        )}

        {errorMessage ? <p style={reviewErrorTextStyle}>{errorMessage}</p> : null}
      </div>
    </DetailSection>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={detailSectionStyle}>
      <h3 style={detailSectionTitleStyle}>{title}</h3>
      {children}
    </section>
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

const menuSyncWrapStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const menuSyncDescriptionStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.45,
  color: "#6b7280",
  fontWeight: 700,
};

const menuSyncButtonStyle: CSSProperties = {
  ...ui.button,
  padding: "10px 12px",
  fontSize: 13,
  borderRadius: 10,
  fontWeight: 800,
};

const menuSyncButtonDisabledStyle: CSSProperties = {
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

const warningTextStyle: CSSProperties = {
  margin: "6px 0 0",
  fontSize: 12,
  lineHeight: 1.45,
  color: "#b45309",
  fontWeight: 800,
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

const receiptListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const receiptItemWrapStyle: CSSProperties = {
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#eef0f3",
  borderRadius: 10,
  overflow: "hidden",
  background: "#ffffff",
  boxShadow: "none",
};

const receiptItemAlternateStyle: CSSProperties = {
  background: "#f9fafb",
};

const receiptItemExpandedStyle: CSSProperties = {
  borderColor: "#cbd5e1",
  boxShadow: "inset 3px 0 0 #64748b",
};

const receiptRowButtonStyle: CSSProperties = {
  width: "100%",
  border: 0,
  background: "transparent",
  padding: "9px 10px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  textAlign: "left",
  cursor: "pointer",
};

const receiptMainStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const receiptTopLineStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
};

const receiptNoStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#111827",
  wordBreak: "break-word",
};

const receiptMetaLineStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 700,
};

const statusBadgeStyle: CSSProperties = {
  ...ui.badgeMini,
  height: 19,
  minWidth: 0,
  flexShrink: 0,
};

const paidBadgeStyle: CSSProperties = {
  background: "#111827",
};

const canceledBadgeStyle: CSSProperties = {
  background: "#dc2626",
};

const modifiedBadgeStyle: CSSProperties = {
  background: "#ffee00",
  color: "#111827",
};

const receiptAmountWrapStyle: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 3,
};

const amountStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.25,
  fontWeight: 900,
  color: "#111827",
};

const receiptTimeStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 800,
};

const chevronStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 800,
};

const dropdownStyle: CSSProperties = {
  padding: "10px",
  background: "#f8fafc",
  borderTop: "1px solid #e2e8f0",
  display: "grid",
  gap: 9,
};

const detailSectionStyle: CSSProperties = {
  padding: "9px",
  background: "#ffffff",
  border: "1px solid #e5e7eb",
  borderRadius: 9,
};

const detailSectionTitleStyle: CSSProperties = {
  margin: "0 0 7px",
  fontSize: 13,
  fontWeight: 900,
  color: "#111827",
};

const miniListStyle: CSSProperties = {
  display: "grid",
  gap: 5,
};

const miniRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto auto",
  alignItems: "center",
  gap: 8,
  padding: "6px 7px",
  borderRadius: 8,
  background: "#f9fafb",
};

const miniLabelStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 800,
  color: "#374151",
};

const miniValueStyle: CSSProperties = {
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#111827",
  whiteSpace: "nowrap",
};

const lineCountStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const mutedTextStyle: CSSProperties = {
  ...ui.metaText,
  margin: 0,
  fontWeight: 700,
};

const paymentBlockStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 8,
  borderTop: "1px solid #eef0f3",
};

const paymentBlockTitleStyle: CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#374151",
};

const cashExtraStyle: CSSProperties = {
  marginTop: 8,
  display: "grid",
  gap: 5,
};

const lineListStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const lineRowStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  padding: "8px",
  borderRadius: 8,
  background: "#f9fafb",
  border: "1px solid #eef0f3",
};

const optionLineRowStyle: CSSProperties = {
  marginLeft: 12,
  background: "#ffffff",
  borderStyle: "dashed",
};

const lineTitleRowStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const lineNameStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#111827",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const optionLineNameStyle: CSSProperties = {
  fontSize: 11,
  color: "#374151",
};

const optionBadgeStyle: CSSProperties = {
  ...ui.badgeMini,
  width: "fit-content",
  minWidth: 0,
  height: 18,
  background: "#6b7280",
};

const lineSummaryStyle: CSSProperties = {
  ...ui.metaText,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  fontWeight: 800,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const lineSummaryAmountStyle: CSSProperties = {
  flexShrink: 0,
  color: "#111827",
  fontWeight: 900,
};

const optionLineSummaryStyle: CSSProperties = {
  fontSize: 11,
};

const editPanelStyle: CSSProperties = {
  display: "grid",
  gap: 8,
};

const editSummaryStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "7px 8px",
  borderRadius: 8,
  background: "#fffbeb",
};

const editButtonStyle: CSSProperties = {
  border: 0,
  borderRadius: 9,
  padding: "9px 12px",
  background: "#111827",
  color: "#ffffff",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  cursor: "pointer",
};

const editLineListStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  minWidth: 0,
};

const existingOptionNoticeStyle: CSSProperties = {
  ...mutedTextStyle,
  padding: "7px 8px",
  borderRadius: 8,
  background: "#f3f4f6",
  color: "#374151",
};

const existingLineGroupStyle: CSSProperties = {
  display: "grid",
  gap: 4,
  minWidth: 0,
  width: "100%",
};

const editLineRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 48px 98px auto",
  gap: 6,
  alignItems: "center",
  minWidth: 0,
  width: "100%",
};

const existingOptionReadOnlyRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 42px 86px 98px",
  gap: 6,
  alignItems: "center",
  marginLeft: 12,
  padding: "6px 8px",
  width: "calc(100% - 12px)",
  maxWidth: "calc(100% - 12px)",
  minWidth: 0,
  boxSizing: "border-box",
  borderRadius: 8,
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
};

const existingOptionMetaStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 11,
  lineHeight: 1.35,
  fontWeight: 800,
  color: "#475569",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const newLineRowStyle: CSSProperties = {
  ...editLineRowStyle,
  gridTemplateColumns: "minmax(0, 1fr) 48px 98px auto",
  background: "#f0fdf4",
  borderRadius: 8,
  padding: 6,
  minWidth: 0,
  width: "100%",
  maxWidth: "100%",
  boxSizing: "border-box",
};

const deletedEditLineRowStyle: CSSProperties = {
  opacity: 0.55,
  textDecoration: "line-through",
};

const editLineNameStyle: CSSProperties = {
  minWidth: 0,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#111827",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const editNameInputStyle: CSSProperties = {
  ...ui.input,
  minWidth: 0,
  padding: "7px 8px",
  fontSize: 12,
  borderRadius: 8,
  fontWeight: 700,
};

const editNumberInputStyle: CSSProperties = {
  ...editNameInputStyle,
  textAlign: "right",
};

const deleteLineButtonStyle: CSSProperties = {
  border: "1px solid #fecaca",
  borderRadius: 8,
  padding: "7px 8px",
  background: "#fff1f2",
  color: "#b91c1c",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const secondaryButtonStyle: CSSProperties = {
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#d1d5db",
  borderRadius: 9,
  padding: "8px 10px",
  background: "#ffffff",
  color: "#374151",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const editActionGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const productSearchStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  paddingTop: 8,
  borderTop: "1px solid #eef0f3",
};

const productResultListStyle: CSSProperties = {
  display: "grid",
  gap: 4,
};

const productResultButtonStyle: CSSProperties = {
  border: "1px solid #374151",
  borderRadius: 8,
  padding: "7px 8px",
  background: "#1f2937",
  color: "#ffffff",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  textAlign: "left",
  cursor: "pointer",
  minWidth: 0,
  width: "100%",
  transition: "background-color 120ms ease, border-color 120ms ease",
};

const productResultButtonSelectedStyle: CSSProperties = {
  background: "#111827",
  borderColor: "#9ca3af",
};

const productResultNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#ffffff",
};

const productResultPriceStyle: CSSProperties = {
  flexShrink: 0,
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  color: "#e5e7eb",
  whiteSpace: "nowrap",
};

const productResultMainStyle: CSSProperties = {
  minWidth: 0,
  display: "grid",
  gap: 2,
};

const selectedProductStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: 6,
  borderRadius: 8,
  background: "#f9fafb",
  minWidth: 0,
  maxWidth: "100%",
  overflow: "hidden",
};

const selectedProductHeaderStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 48px auto",
  gap: 6,
  alignItems: "center",
};

const optionSelectionStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  paddingTop: 6,
  borderTop: "1px solid #e5e7eb",
  minWidth: 0,
  maxWidth: "100%",
};

const optionGroupStyle: CSSProperties = {
  display: "grid",
  gap: 5,
  minWidth: 0,
  maxWidth: "100%",
};

const optionButtonListStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
  minWidth: 0,
  maxWidth: "100%",
};

const optionButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  minWidth: 0,
  maxWidth: "100%",
  overflow: "hidden",
};

const optionButtonNameStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const optionButtonPriceStyle: CSSProperties = {
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const newOptionLineRowStyle: CSSProperties = {
  marginLeft: 12,
  background: "#f8fafc",
  border: "1px dashed #cbd5e1",
  width: "calc(100% - 12px)",
  maxWidth: "calc(100% - 12px)",
};

const paymentEditBlockStyle: CSSProperties = {
  display: "grid",
  gap: 7,
  paddingTop: 8,
  borderTop: "1px solid #eef0f3",
};

const paymentMethodButtonsStyle: CSSProperties = {
  display: "flex",
  gap: 6,
};

const activeSegmentStyle: CSSProperties = {
  background: "#111827",
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "#111827",
  color: "#ffffff",
};

const cashPaymentEditStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const cashInputLabelStyle: CSSProperties = {
  display: "grid",
  gap: 5,
};

const editTextareaStyle: CSSProperties = {
  ...ui.input,
  minHeight: 58,
  padding: "8px 9px",
  fontSize: 12,
  lineHeight: 1.45,
  borderRadius: 9,
  fontWeight: 700,
  resize: "vertical",
};

const reviewFooterStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const reviewCurrentStatusStyle: CSSProperties = {
  ...ui.metaText,
  fontWeight: 800,
};

const reviewSaveButtonStyle: CSSProperties = {
  border: 0,
  borderRadius: 9,
  padding: "8px 12px",
  background: "#111827",
  color: "#ffffff",
  fontSize: 12,
  lineHeight: 1.35,
  fontWeight: 900,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const reviewSaveButtonDisabledStyle: CSSProperties = {
  opacity: 0.45,
  cursor: "not-allowed",
};

const reviewErrorTextStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.45,
  color: "#dc2626",
  fontWeight: 800,
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
