export const PARTNER_MANAGER_ROLES = ["owner", "master"] as const;
export const PARTNER_TYPES = ["food", "alcohol", "beverage", "consumable", "equipment", "service", "rent", "other"] as const;
export const PAYMENT_MODES = ["immediate", "postpaid"] as const;

export type PartnerType = (typeof PARTNER_TYPES)[number];
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export type PartnerInput = {
  name: string;
  partnerType: PartnerType;
  paymentMode: PaymentMode;
  defaultPaymentTermDays: number | null;
  phone: string | null;
  contactName: string | null;
  memo: string | null;
  isActive: boolean;
  ledgerPartyId: number | null;
};

const optionalText = (value: unknown, max: number) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length <= max ? normalized || null : undefined;
};

export function parsePartnerInput(value: unknown): PartnerInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const partnerType = input.partnerType;
  const paymentMode = input.paymentMode;
  const phone = optionalText(input.phone, 80);
  const contactName = optionalText(input.contactName, 120);
  const memo = optionalText(input.memo, 5000);
  const term = input.defaultPaymentTermDays;
  const ledgerPartyId = input.ledgerPartyId === null || input.ledgerPartyId === undefined || input.ledgerPartyId === ""
    ? null : Number(input.ledgerPartyId);

  if (name.length < 1 || name.length > 200) return null;
  if (!PARTNER_TYPES.includes(partnerType as PartnerType)) return null;
  if (!PAYMENT_MODES.includes(paymentMode as PaymentMode)) return null;
  if (phone === undefined || contactName === undefined || memo === undefined) return null;
  if (typeof input.isActive !== "boolean") return null;
  if (ledgerPartyId !== null && (!Number.isSafeInteger(ledgerPartyId) || ledgerPartyId < 1)) return null;
  const hasTerm = term !== null && term !== undefined && term !== "";
  const termNumber = Number(term);
  const defaultPaymentTermDays = paymentMode === "immediate" ? null : termNumber;
  if (paymentMode === "postpaid" && (!hasTerm || !Number.isInteger(termNumber) || termNumber < 0 || termNumber > 3650)) return null;

  return {
    name,
    partnerType: partnerType as PartnerType,
    paymentMode: paymentMode as PaymentMode,
    defaultPaymentTermDays,
    phone,
    contactName,
    memo,
    isActive: input.isActive,
    ledgerPartyId,
  };
}
