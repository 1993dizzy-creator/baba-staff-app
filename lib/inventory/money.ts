export const normalizePriceInput = (
  value: string | number | null | undefined
) => {
  return String(value ?? "").replace(/[^\d]/g, "");
};

export const formatNumber = (value: string | number | null | undefined) => {
  const digits = normalizePriceInput(value);
  return digits ? Number(digits).toLocaleString("en-US") : "";
};

export const parsePrice = (value: string | number | null | undefined) => {
  const digits = normalizePriceInput(value);
  return digits ? Number(digits) : null;
};

export const formatMoneyDisplay = (
  value: string | number | null | undefined
) => {
  if (value === null || value === undefined || value === "") return "-";

  const num =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/[^\d.-]/g, ""));

  if (!Number.isFinite(num)) return "-";

  return `${num.toLocaleString("en-US")} ₫`;
};