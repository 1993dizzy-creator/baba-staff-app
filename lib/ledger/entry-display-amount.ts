import type { LedgerEntry } from "./entries";

// Presentation only. LedgerEntry.amount and direction remain accounting values.
export function entryDisplayAmount(entry: Pick<LedgerEntry, "amount" | "systemDisplay">) {
  return entry.systemDisplay?.kind === "payablePayment"
    ? entry.systemDisplay.actualPaidAmount ?? entry.amount
    : entry.amount;
}

export function entryDisplayAmountSign(entry: Pick<LedgerEntry, "direction" | "paymentTransaction" | "employeeCost" | "fundFlow" | "systemDisplay">) {
  if (entry.paymentTransaction) return "";
  if (entry.systemDisplay?.kind === "investment") {
    return entry.systemDisplay.cashFlow === "outflow" ? "−" :
      entry.systemDisplay.cashFlow === "inflow" ? "+" : "";
  }
  if (entry.direction === "income") return "+";
  if (entry.direction === "expense") return "−";
  if (entry.employeeCost && entry.fundFlow === "outflow") return "−";
  return "";
}
