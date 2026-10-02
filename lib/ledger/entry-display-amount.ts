// @ts-expect-error Node's local strip-types test runner requires the extension.
import { isPayrollPaymentOutflow, type LedgerEntry } from "./entries.ts";

// Presentation only. LedgerEntry.amount and direction remain accounting values.
export function entryDisplayAmount(entry: Pick<LedgerEntry, "amount" | "systemDisplay">) {
  return entry.systemDisplay?.kind === "payablePayment"
    ? entry.systemDisplay.actualPaidAmount ?? entry.amount
    : entry.amount;
}

export function entryDisplayAmountSign(entry: Pick<LedgerEntry, "direction" | "paymentTransaction" | "payrollPayment" | "fundFlow" | "systemDisplay" | "userAdjustment">) {
  // Payments and user-facing adjustments show a plain, unsigned amount.
  if (entry.paymentTransaction || entry.userAdjustment) return "";
  if (entry.systemDisplay?.kind === "investment") {
    return entry.systemDisplay.cashFlow === "outflow" ? "−" :
      entry.systemDisplay.cashFlow === "inflow" ? "+" : "";
  }
  if (entry.direction === "income") return "+";
  if (entry.direction === "expense") return "−";
  if (isPayrollPaymentOutflow(entry)) return "−";
  return "";
}

export function entryDisplayAmountTone(entry: Pick<LedgerEntry, "direction" | "payrollPayment" | "fundFlow" | "userAdjustment">): "income" | "expense" | "transfer" {
  if (entry.userAdjustment) return "transfer";
  if (entry.direction === "income") return "income";
  if (entry.direction === "expense" || isPayrollPaymentOutflow(entry)) return "expense";
  return "transfer";
}
