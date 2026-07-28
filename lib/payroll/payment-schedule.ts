export const DEFAULT_PAYMENT_DAY = 10;
export const PAYMENT_MONTH_OFFSET = 1;

export function resolvePayrollPaymentDate(
  payrollMonth: string,
  paymentDay = DEFAULT_PAYMENT_DAY,
  monthOffset = PAYMENT_MONTH_OFFSET
) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(payrollMonth)) throw new Error("INVALID_PAYROLL_MONTH");
  if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 28) throw new Error("INVALID_PAYMENT_DAY");
  const [year, month] = payrollMonth.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + monthOffset, paymentDay));
  return date.toISOString().slice(0, 10);
}
