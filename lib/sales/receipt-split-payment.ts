export function splitReceiptPayment(finalAmount: number, cashAmount: unknown) {
  const cash = typeof cashAmount === "number" ? cashAmount :
    typeof cashAmount === "string" && cashAmount.trim() !== "" ? Number(cashAmount) : NaN;
  if (!Number.isSafeInteger(finalAmount) || finalAmount <= 0 ||
      !Number.isSafeInteger(cash) || cash <= 0 || cash >= finalAmount) return null;
  return { cashAmount: cash, otherAmount: finalAmount - cash, paymentTotal: finalAmount };
}
