export const RECEIPT_CONTENT_FINGERPRINT_VERSION = 2;

type CanonicalPrimitive = boolean | number | string | null;
type CanonicalValue =
  | CanonicalPrimitive
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export type ReceiptContentFingerprintLineInput = {
  itemId: string | null;
  itemCode: string | null;
  optionIdentity: string | null;
  refDetailId: string | null;
  parentRefDetailId: string | null;
  quantity: number | string | null;
  isOption: boolean | null;
  isExcluded: boolean | null;
  isCanceled: boolean | null;
  refDetailType: number | null;
  inventoryItemType: number | null;
};

export type ReceiptContentFingerprintInput = {
  receiptId: number;
  refId: string | null;
  source: string | null;
  paymentStatus: number | null;
  isCanceled: boolean | null;
  lines: ReceiptContentFingerprintLineInput[];
};

function normalizeString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBoolean(value: unknown) {
  return value === true;
}

function normalizeNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(6));
}

function getLineItemIdentity(line: ReceiptContentFingerprintLineInput) {
  const itemId = normalizeString(line.itemId);
  if (itemId) return { kind: "item_id", value: itemId };
  return { kind: "item_code", value: normalizeString(line.itemCode) };
}

export function stableStringifyFingerprint(value: CanonicalValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringifyFingerprint).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringifyFingerprint(value[key])}`
    )
    .join(",")}}`;
}

export function buildReceiptContentFingerprintPayload(
  input: ReceiptContentFingerprintInput
) {
  const lines = input.lines
    .map((line) => {
      const itemIdentity = getLineItemIdentity(line);
      return {
        itemIdentityKind: itemIdentity.kind,
        itemIdentityValue: itemIdentity.value,
        optionIdentity: normalizeString(line.optionIdentity),
        refDetailId: normalizeString(line.refDetailId),
        parentRefDetailId: normalizeString(line.parentRefDetailId),
        quantity: normalizeNumber(line.quantity),
        isOption: normalizeBoolean(line.isOption),
        isExcluded: normalizeBoolean(line.isExcluded),
        isCanceled: normalizeBoolean(line.isCanceled),
        refDetailType: line.refDetailType ?? null,
        inventoryItemType: line.inventoryItemType ?? null,
      };
    })
    .sort((left, right) =>
      [
        left.parentRefDetailId ?? "",
        left.refDetailId ?? "",
        left.itemIdentityKind,
        left.itemIdentityValue ?? "",
        left.optionIdentity ?? "",
        String(left.refDetailType ?? ""),
        String(left.inventoryItemType ?? ""),
        String(left.isOption),
        String(left.isExcluded),
        String(left.isCanceled),
        String(left.quantity ?? ""),
      ]
        .join("\u001f")
        .localeCompare(
          [
            right.parentRefDetailId ?? "",
            right.refDetailId ?? "",
            right.itemIdentityKind,
            right.itemIdentityValue ?? "",
            right.optionIdentity ?? "",
            String(right.refDetailType ?? ""),
            String(right.inventoryItemType ?? ""),
            String(right.isOption),
            String(right.isExcluded),
            String(right.isCanceled),
            String(right.quantity ?? ""),
          ].join("\u001f")
        )
    );

  return {
    version: RECEIPT_CONTENT_FINGERPRINT_VERSION,
    receipt: {
      receiptId: Number(input.receiptId),
      refId: normalizeString(input.refId),
      source: normalizeString(input.source),
      paymentStatus: input.paymentStatus ?? null,
      isCanceled: normalizeBoolean(input.isCanceled),
    },
    lines,
  };
}

export function getReceiptContentFingerprintCanonical(
  input: ReceiptContentFingerprintInput
) {
  return stableStringifyFingerprint(buildReceiptContentFingerprintPayload(input));
}
