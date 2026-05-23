export const normalizeVietnameseText = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ");

export const normalizeInventoryName = normalizeVietnameseText;

export const normalizeInventoryCode = normalizeVietnameseText;
