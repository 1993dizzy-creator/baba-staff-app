export const toNumber = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === "") return 0;

  const num =
    typeof value === "number"
      ? value
      : Number(String(value).replace(/,/g, "").trim());

  return Number.isFinite(num) ? num : 0;
};

export const parseDecimal = (value: string | number | null | undefined) => {
  return toNumber(value);
};

export const roundDecimal = (value: number) => {
  return Math.round(value * 1000) / 1000;
};

export const formatDecimalDisplay = (
  value: string | number | null | undefined
) => {
  const num = toNumber(value);

  return num.toFixed(3).replace(/\.?0+$/, "");
};