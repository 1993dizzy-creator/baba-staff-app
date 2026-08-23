export const PARTNER_MANAGER_ROLES = ["owner", "master"] as const;
export const PARTNER_TYPES = ["food", "alcohol", "beverage", "consumable", "equipment", "service", "rent", "other"] as const;
export const PAYMENT_MODES = ["immediate", "postpaid"] as const;
export const SETTLEMENT_MODES = ["ad_hoc", "scheduled"] as const;
export const SETTLEMENT_RULES = ["net_days", "monthly_once", "monthly_twice"] as const;

export type PartnerType = (typeof PARTNER_TYPES)[number];
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];
export type SettlementRule = (typeof SETTLEMENT_RULES)[number];

export type PartnerInput = {
  name: string;
  partnerType: PartnerType;
  paymentMode: PaymentMode;
  settlementMode: SettlementMode | null;
  settlementRule: SettlementRule | null;
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
  const settlementMode = input.settlementMode === null || input.settlementMode === undefined || input.settlementMode === "" ? null : input.settlementMode;
  const settlementRule = input.settlementRule === null || input.settlementRule === undefined || input.settlementRule === "" ? null : input.settlementRule;
  const phone = optionalText(input.phone, 80);
  const contactName = optionalText(input.contactName, 120);
  const memo = optionalText(input.memo, 5000);
  const term = input.defaultPaymentTermDays;
  const ledgerPartyId = input.ledgerPartyId === null || input.ledgerPartyId === undefined || input.ledgerPartyId === ""
    ? null : Number(input.ledgerPartyId);

  if (name.length < 1 || name.length > 200) return null;
  if (!PARTNER_TYPES.includes(partnerType as PartnerType)) return null;
  if (!PAYMENT_MODES.includes(paymentMode as PaymentMode)) return null;
  if (settlementMode !== null && !SETTLEMENT_MODES.includes(settlementMode as SettlementMode)) return null;
  if (settlementRule !== null && !SETTLEMENT_RULES.includes(settlementRule as SettlementRule)) return null;
  if (phone === undefined || contactName === undefined || memo === undefined) return null;
  if (typeof input.isActive !== "boolean") return null;
  if (ledgerPartyId !== null && (!Number.isSafeInteger(ledgerPartyId) || ledgerPartyId < 1)) return null;
  const hasTerm = term !== null && term !== undefined && term !== "";
  const termNumber = hasTerm ? Number(term) : null;
  if (paymentMode === "immediate" && (settlementMode !== null || settlementRule !== null || hasTerm)) return null;
  if (paymentMode === "postpaid" && settlementMode === null) return null;
  if (settlementMode === "ad_hoc" && (settlementRule !== null || hasTerm)) return null;
  if (settlementMode === "scheduled" && settlementRule === null) return null;
  if (settlementRule === "net_days" && (termNumber === null || !Number.isInteger(termNumber) || termNumber < 0 || termNumber > 3650)) return null;
  if ((settlementRule === "monthly_once" || settlementRule === "monthly_twice") && hasTerm) return null;

  return {
    name,
    partnerType: partnerType as PartnerType,
    paymentMode: paymentMode as PaymentMode,
    settlementMode: settlementMode as SettlementMode | null,
    settlementRule: settlementRule as SettlementRule | null,
    defaultPaymentTermDays: termNumber,
    phone,
    contactName,
    memo,
    isActive: input.isActive,
    ledgerPartyId,
  };
}
