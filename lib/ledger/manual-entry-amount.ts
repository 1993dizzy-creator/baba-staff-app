export function sanitizeLedgerAmountInput(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.replace(/^0+(?=\d)/, "");
}

export function formatLedgerAmountInput(value: string) {
  const digits = sanitizeLedgerAmountInput(value);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function parseLedgerAmount(value: string) {
  const digits = sanitizeLedgerAmountInput(value);
  if (!digits) return null;
  const amount = Number(digits);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
