export function formatVnd(value: number | null | undefined) {
  return `${Number(value ?? 0).toLocaleString("en-US")} ₫`;
}

export function formatSignedVnd(
  value: number | null | undefined,
  sign: "+" | "-",
) {
  const amount = Number(value ?? 0);
  return amount === 0 ? formatVnd(0) : `${sign}${formatVnd(amount)}`;
}

export function formatCompactVnd(value: number) {
  const rounded = Math.trunc(value);
  const sign = rounded < 0 ? "-" : "";
  let remainder = Math.abs(rounded);
  const millions = Math.floor(remainder / 1_000_000);
  remainder %= 1_000_000;
  const thousands = Math.floor(remainder / 1_000);
  const units = remainder % 1_000;

  const parts = [
    millions > 0 ? `${millions}tr` : "",
    thousands > 0 ? `${thousands}k` : "",
    units > 0 || (millions === 0 && thousands === 0) ? String(units) : "",
  ];
  return `${sign}${parts.join("")} ₫`;
}

export function formatPayrollHeaderAmount(
  monthlyAmount: number,
) {
  return formatCompactVnd(monthlyAmount);
}

export function formatContractRate(
  value: number | null | undefined,
  payType: "monthly" | "daily" | "hourly",
  lang: "ko" | "vi",
  sign?: "+" | "-",
) {
  const formatted = sign ? formatSignedVnd(value, sign) : formatVnd(value);
  return payType === "hourly"
    ? `${formatted}/${lang === "vi" ? "giờ" : "시간"}`
    : formatted;
}
