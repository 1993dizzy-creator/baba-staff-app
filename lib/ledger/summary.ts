export function computeReceivedIncome(
  recognizedIncome: number,
  cardGrossSales: number,
  actualCardDeposits: number,
) {
  return recognizedIncome - cardGrossSales + actualCardDeposits;
}

// paidExpense is recognition-month based. Add only prepaid payments with a
// real outgoing movement from this business month for the user-facing card.
export function computeDisplayedExpense(
  paidExpense: number,
  transactions: readonly { type: string; amount: number | string; economic_effect_sign?: number | string | null; movements?: readonly { amount?: number | string }[] }[],
) {
  const prepaidOutflow = transactions
    .filter(row => row.type === "prepaid_expense_payment" && row.movements?.some(movement => Number(movement.amount) < 0))
    .reduce((sum, row) => sum + Number(row.amount) * Number(row.economic_effect_sign ?? 1), 0);
  return paidExpense + prepaidOutflow;
}
