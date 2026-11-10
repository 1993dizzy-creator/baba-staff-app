import type { OpenOrderKpi } from "../pos/cukcuk/open-orders-core.ts";

export type DailyKpiSummary = {
  totalSales: number;
  receiptCount: number;
  paidReceiptCount: number;
  salesLineCount: number;
  optionLineCount: number;
  averageReceiptAmount: number;
};

/** Presentation only. The paid summary and central order classification stay unchanged. */
export function buildDailySalesKpi(input: {
  summary: DailyKpiSummary;
  openOrders?: OpenOrderKpi;
  businessDate: string;
  isLiveBusinessDay: boolean;
  isClosed: boolean;
}) {
  const { summary, openOrders } = input;
  const paid = {
    amount: summary.totalSales,
    receiptCount: summary.receiptCount,
    menuLineCount: summary.salesLineCount,
    averageAmount: summary.averageReceiptAmount,
  };
  // Closed/historical days use exactly the existing paid summary. No client date arithmetic.
  if (input.isClosed || !input.isLiveBusinessDay || openOrders?.status === "closed") {
    return { ...paid, mode: "paid" as const, menuNeedsReview: false, openOrders: undefined };
  }
  const sameSnapshot = openOrders?.businessDate === input.businessDate
    && openOrders.paid.amount === summary.totalSales
    && openOrders.paid.receiptCount === summary.paidReceiptCount;
  if (!sameSnapshot || openOrders?.status !== "ok" || !openOrders.open || !openOrders.provisional) {
    // These are paid-only numbers, never an inferred zero for missing open orders.
    return { ...paid, averageAmount: null, mode: "unavailable" as const, menuNeedsReview: false,
      openOrders: sameSnapshot ? openOrders : undefined };
  }
  const menuNeedsReview = !Array.isArray(openOrders.detailWarnings) || openOrders.detailWarnings.length > 0;
  return {
    amount: openOrders.provisional.amount,
    receiptCount: openOrders.provisional.count,
    // Keep menu/option definitions from the central snapshot. Unverified menus are
    // not presented as actual sold lines (Status 6, amount mismatch, orphan options).
    menuLineCount: summary.salesLineCount + (menuNeedsReview ? 0 : openOrders.open.menuLineCount),
    averageAmount: openOrders.complete ? openOrders.provisional.averageAmount : null,
    mode: openOrders.complete ? "complete" as const : "partial" as const,
    menuNeedsReview,
    openOrders,
  };
}
