// @ts-expect-error Node's local strip-types test runner requires the extension.
import { isPayrollPaymentOutflow, type LedgerEntry } from "./entries.ts";
// @ts-expect-error Node's local strip-types test runner requires the extension.
import { reserveEntryDisplaySign } from "./reserve-text.ts";

// Presentation only. LedgerEntry.amount and direction remain accounting values.
export function entryDisplayAmount(entry: Pick<LedgerEntry, "amount" | "systemDisplay">) {
  // A kept payment row omits the part already shown on this month's purchase rows.
  return entry.systemDisplay?.kind === "payablePayment"
    ? (entry.systemDisplay.actualPaidAmount ?? entry.amount) - (entry.systemDisplay.listedPayablesAmount ?? 0)
    : entry.amount;
}

export function entryDisplayAmountSign(entry: Pick<LedgerEntry, "direction" | "paymentTransaction" | "payrollPayment" | "fundFlow" | "systemDisplay" | "userAdjustment" | "prepaidAllocation">) {
  // Payments, user-facing adjustments and prepaid allocations (no money moves)
  // show a plain, unsigned amount.
  if (entry.paymentTransaction || entry.userAdjustment || entry.prepaidAllocation) return "";
  if (entry.systemDisplay?.kind === "investment") {
    return entry.systemDisplay.cashFlow === "outflow" ? "−" :
      entry.systemDisplay.cashFlow === "inflow" ? "+" : "";
  }
  // Reserve rows keep an unsigned amount; the sign matches the settings 준비금 기록.
  if (entry.systemDisplay?.kind === "reserve") {
    return reserveEntryDisplaySign(entry.systemDisplay.entryType, entry.systemDisplay.signedAmount);
  }
  if (entry.direction === "income") return "+";
  if (entry.direction === "expense") return "−";
  if (isPayrollPaymentOutflow(entry)) return "−";
  return "";
}

export function entryDisplayAmountTone(entry: Pick<LedgerEntry, "direction" | "payrollPayment" | "fundFlow" | "userAdjustment" | "prepaidAllocation">): "income" | "expense" | "transfer" {
  if (entry.userAdjustment || entry.prepaidAllocation) return "transfer";
  if (entry.direction === "income") return "income";
  if (entry.direction === "expense" || isPayrollPaymentOutflow(entry)) return "expense";
  return "transfer";
}
