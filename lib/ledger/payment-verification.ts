// @ts-expect-error Node's local strip-types test runner requires the extension.
import { calculatePurchaseSettlement, type PayablePayment, type PurchaseSettlement } from "./payables.ts";

export type VerificationSource = {
  id: number | string;
  party_id: number | string;
  original_amount: number | string;
  status: string;
  party?: { name?: string } | null;
  expense?: {
    id: number | string;
    business_date: string;
    status: string;
    source_snapshot?: Record<string, unknown> | null;
  } | null;
};

export type VerificationAllocation = {
  payable_id: number | string;
  allocated_amount: number | string;
  payment?: PayablePayment | null;
};

export function isPaymentVerification(source: VerificationSource) {
  return source.expense?.source_snapshot?.paymentVerification === "pending";
}

export function buildPaymentVerificationItems(
  sources: readonly VerificationSource[],
  allocations: readonly VerificationAllocation[],
) {
  const items = sources.filter(source => source.status !== "cancelled" && source.expense?.status === "confirmed" && isPaymentVerification(source)).map(source => {
    const paid = allocations.filter(allocation => Number(allocation.payable_id) === Number(source.id) && allocation.payment?.status === "confirmed");
    const settlement:PurchaseSettlement=calculatePurchaseSettlement(source.original_amount,paid,{payableId:source.id,transactionId:source.expense?.id});
    const paidAmount = settlement.cashPaidAmount;
    const amount = Number(source.original_amount);
    const snapshot = source.expense?.source_snapshot ?? {};
    return {
      payableId: Number(source.id),
      partyId: Number(source.party_id),
      businessDate: source.expense?.business_date ?? "",
      itemName: String(snapshot.item_name ?? "-") || "-",
      itemNameVi: snapshot.item_name_vi == null ? null : String(snapshot.item_name_vi),
      supplierName: String(snapshot.supplier ?? source.party?.name ?? "-") || "-",
      quantity: snapshot.change_quantity == null ? null : Number(snapshot.change_quantity),
      unitPrice: snapshot.purchase_price == null ? null : Number(snapshot.purchase_price),
      amount,
      paidAmount,
      purchaseSettlement:settlement,
      remainingAmount: settlement.remainingAmount,
      appPaymentStatus: settlement.status==="paid" ? "confirmed" as const : "unconfirmed" as const,
      paymentDate: paid.filter(allocation=>allocation.payment?.type!=="expense").map(allocation => allocation.payment!.business_date).sort().at(-1) ?? null,
    };
  });
  return {
    items,
    totalPending: items.reduce((total, item) => total + item.remainingAmount, 0),
    pendingCount: items.filter(item => item.remainingAmount > 0).length,
  };
}
