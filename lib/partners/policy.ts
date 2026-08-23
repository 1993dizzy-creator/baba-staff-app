export const PARTNER_MANAGER_ROLES = ["owner", "master"] as const;
export const PARTNER_TYPES = ["food", "alcohol", "beverage", "consumable", "equipment", "service", "rent", "other"] as const;
export const PARTNER_TYPE_GROUP_ORDER = ["alcohol", "beverage", "food", "consumable", "equipment", "service", "rent", "other"] as const;
export const PAYMENT_MODES = ["immediate", "postpaid"] as const;
export const SETTLEMENT_MODES = ["ad_hoc", "scheduled"] as const;
export const SETTLEMENT_RULES = ["net_days", "monthly_once", "monthly_twice"] as const;

export type PartnerType = (typeof PARTNER_TYPES)[number];
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];
export type SettlementRule = (typeof SETTLEMENT_RULES)[number];

export function groupPartnersByType<T extends { name: string; partnerType: PartnerType; isActive: boolean }>(partners: T[], isActive: boolean, locale: "ko" | "vi") {
  return PARTNER_TYPE_GROUP_ORDER
    .map(type => ({
      type,
      partners: partners
        .filter(partner => partner.isActive === isActive && partner.partnerType === type)
        .sort((a, b) => a.name.localeCompare(b.name, locale)),
    }))
    .filter(group => group.partners.length > 0);
}

export type PartnerInput = {
  name: string;
  partnerType: PartnerType;
  paymentMode: PaymentMode;
  settlementMode: SettlementMode | null;
  settlementRule: SettlementRule | null;
  defaultPaymentTermDays: number | null;
  defaultFundAccountId: number | null;
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
  const ledgerPartyId = input.ledgerPartyId === null || input.ledgerPartyId === undefined || input.ledgerPartyId === ""
    ? null : Number(input.ledgerPartyId);
  const defaultFundAccountId = input.defaultFundAccountId === null || input.defaultFundAccountId === undefined || input.defaultFundAccountId === ""
    ? null : Number(input.defaultFundAccountId);

  if (name.length < 1 || name.length > 200) return null;
  if (!PARTNER_TYPES.includes(partnerType as PartnerType)) return null;
  if (!PAYMENT_MODES.includes(paymentMode as PaymentMode)) return null;
  if (phone === undefined || contactName === undefined || memo === undefined) return null;
  if (typeof input.isActive !== "boolean") return null;
  if (ledgerPartyId !== null && (!Number.isSafeInteger(ledgerPartyId) || ledgerPartyId < 1)) return null;
  if (defaultFundAccountId !== null && (!Number.isSafeInteger(defaultFundAccountId) || defaultFundAccountId < 1)) return null;
  const settlementMode: SettlementMode | null = paymentMode === "postpaid" ? "ad_hoc" : null;

  return {
    name,
    partnerType: partnerType as PartnerType,
    paymentMode: paymentMode as PaymentMode,
    settlementMode: settlementMode as SettlementMode | null,
    settlementRule: null,
    defaultPaymentTermDays: null,
    defaultFundAccountId,
    phone,
    contactName,
    memo,
    isActive: input.isActive,
    ledgerPartyId,
  };
}
