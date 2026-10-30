// 실청구금액 (item billed amount) of one purchase receipt.
// auto: quantity x unit price, recalculated while quantity or price change. The server stores
//       no amount (billed_amount NULL), so the Ledger keeps the existing calculation.
// manual: the amount the vendor billed, kept through quantity/price changes until the user
//       restores auto. It stays manual even when it equals the calculated amount.
// The actual cash payment is not this amount; it is recorded by the Ledger payment feature.
// No runtime imports: tests load this file directly. Digits-only input like lib/inventory/money.
const digitsOf = (value: string | number) => String(value).replace(/[^\d]/g, "");
const parsePrice = (value: string) => (digitsOf(value) ? Number(digitsOf(value)) : null);
const formatNumber = (value: string | number) => (digitsOf(value) ? Number(digitsOf(value)).toLocaleString("en-US") : "");

export type BilledAmountMode = "auto" | "manual";
export type BilledAmountDraft = { mode: BilledAmountMode; manualText: string };
export type BilledAmountRequest = { mode: "auto" } | { mode: "manual"; amount: number };

export const BILLED_AMOUNT_MAX = 10_000_000_000_000;
export const AUTO_BILLED_AMOUNT: BilledAmountDraft = { mode: "auto", manualText: "" };

// Same rounding as the Ledger projector: round(quantity x price, 3).
export function calculatePurchaseAmount(quantity: number | null | undefined, unitPrice: number | null | undefined) {
  if (quantity == null || unitPrice == null || !Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return null;
  if (quantity < 0 || unitPrice <= 0) return null;
  return Math.round(quantity * unitPrice * 1000) / 1000;
}

export function manualBilledDraft(amount: number | string | null | undefined): BilledAmountDraft {
  return amount == null || amount === "" ? AUTO_BILLED_AMOUNT : { mode: "manual", manualText: formatNumber(Math.round(Number(amount))) };
}

// Typing in the field always means manual, even the calculated value itself.
export const editBilledAmountDraft = (text: string): BilledAmountDraft => ({ mode: "manual", manualText: formatNumber(text) });

export function resolveBilledAmount(draft: BilledAmountDraft, calculated: number | null) {
  const manual = draft.mode === "manual" ? parsePrice(draft.manualText) : null;
  const billed = draft.mode === "manual" ? manual : calculated;
  return {
    mode: draft.mode,
    calculated,
    billed,
    difference: billed != null && calculated != null ? Math.round((billed - calculated) * 1000) / 1000 : null,
    // Manual needs a positive amount and a positive calculated amount (quantity and unit price).
    valid: draft.mode === "auto" || (manual != null && manual > 0 && manual < BILLED_AMOUNT_MAX && calculated != null && calculated > 0),
  };
}

export const billedAmountRequest = (draft: BilledAmountDraft): BilledAmountRequest | null => {
  if (draft.mode === "auto") return { mode: "auto" };
  const amount = parsePrice(draft.manualText);
  return amount != null && amount > 0 && amount < BILLED_AMOUNT_MAX ? { mode: "manual", amount } : null;
};

// Server-side parse of the API field. undefined = not sent (older client).
export function parseBilledAmountRequest(value: unknown): BilledAmountRequest | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const { mode, amount } = value as { mode?: unknown; amount?: unknown };
  if (mode === "auto") return amount === undefined || amount === null ? { mode: "auto" } : "invalid";
  if (mode !== "manual" || typeof amount !== "number" || !Number.isFinite(amount)) return "invalid";
  if (amount <= 0 || amount >= BILLED_AMOUNT_MAX || Math.round(amount * 1000) / 1000 !== amount) return "invalid";
  return { mode: "manual", amount };
}

// Effective billed state of a purchase family (root + linked edit logs): the latest log with an
// explicit mode decides; legacy logs (no mode) are automatic. Mirrors the DB projector rule.
export type BilledAmountLog = { id: number; billed_amount_mode?: string | null; billed_amount?: number | string | null };
export function effectiveBilledAmount(family: BilledAmountLog[], quantity: number | null, unitPrice: number | null) {
  const latest = [...family].filter(log => log.billed_amount_mode === "auto" || log.billed_amount_mode === "manual")
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  const calculated = calculatePurchaseAmount(quantity, unitPrice);
  const manual = latest?.billed_amount_mode === "manual" && calculated != null && calculated > 0 ? Number(latest.billed_amount) : null;
  const billed = manual != null && Number.isFinite(manual) ? manual : calculated;
  return {
    mode: (manual != null ? "manual" : "auto") as BilledAmountMode,
    calculated,
    billed,
    difference: billed != null && calculated != null ? Math.round((billed - calculated) * 1000) / 1000 : null,
  };
}
