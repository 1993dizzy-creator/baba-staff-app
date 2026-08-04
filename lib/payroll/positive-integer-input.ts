export function normalizePositiveIntegerInput(value: string) {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return digits.replace(/^0+(?=\d)/, "");
}

export function formatPositiveIntegerInput(value: string) {
  if (!value) return "";
  return Number(value).toLocaleString("en-US");
}
