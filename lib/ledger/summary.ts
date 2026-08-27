export function computeReceivedIncome(
  recognizedIncome: number,
  cardGrossSales: number,
  actualCardDeposits: number,
) {
  return recognizedIncome - cardGrossSales + actualCardDeposits;
}
