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

export type PartnerSubtypeRef = { id: number; partnerType: PartnerType; sortOrder: number };

// Adds a subtype layer under groupPartnersByType's partner_type grouping: 대분류 -> 중분류
// (business_partner_subtypes.sort_order ASC, active or inactive -- an inactive subtype
// already referencing a Partner must keep showing correctly here) -> Partner (name sort,
// unchanged). Partners with no subtype, or one that no longer resolves, always form a
// trailing "미분류/Chưa phân loại" subgroup so a null/stale subtype is never hidden.
export function groupPartnersByTypeAndSubtype<T extends { name: string; partnerType: PartnerType; partnerSubtypeId: number | null; isActive: boolean }, S extends PartnerSubtypeRef>(
  partners: T[],
  isActive: boolean,
  locale: "ko" | "vi",
  subtypes: readonly S[],
) {
  return PARTNER_TYPE_GROUP_ORDER
    .map(type => {
      const typePartners = partners.filter(partner => partner.isActive === isActive && partner.partnerType === type);
      const typeSubtypes = subtypes.filter(subtype => subtype.partnerType === type).sort((a, b) => a.sortOrder - b.sortOrder);
      const knownSubtypeIds = new Set(typeSubtypes.map(subtype => subtype.id));
      const subgroups = typeSubtypes
        .map(subtype => ({
          subtype,
          partners: typePartners.filter(partner => partner.partnerSubtypeId === subtype.id).sort((a, b) => a.name.localeCompare(b.name, locale)),
        }))
        .filter(group => group.partners.length > 0);
      const unclassified = typePartners
        .filter(partner => partner.partnerSubtypeId === null || !knownSubtypeIds.has(partner.partnerSubtypeId))
        .sort((a, b) => a.name.localeCompare(b.name, locale));
      return { type, partners: typePartners, subgroups, unclassified };
    })
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
  partnerSubtypeId: number | null;
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

// Optional single user-facing display tag (e.g. "공식 공급처"), independent of the main
// Partner mutation contract. null/undefined -> null; blank -> null; >30 chars -> undefined (invalid).
export function parseDisplayTag(value: unknown): string | null | undefined {
  return optionalText(value, 30);
}

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
  const partnerSubtypeId = input.partnerSubtypeId === null || input.partnerSubtypeId === undefined || input.partnerSubtypeId === ""
    ? null : Number(input.partnerSubtypeId);

  if (name.length < 1 || name.length > 200) return null;
  if (!PARTNER_TYPES.includes(partnerType as PartnerType)) return null;
  if (!PAYMENT_MODES.includes(paymentMode as PaymentMode)) return null;
  if (phone === undefined || contactName === undefined || memo === undefined) return null;
  if (typeof input.isActive !== "boolean") return null;
  if (ledgerPartyId !== null && (!Number.isSafeInteger(ledgerPartyId) || ledgerPartyId < 1)) return null;
  if (defaultFundAccountId !== null && (!Number.isSafeInteger(defaultFundAccountId) || defaultFundAccountId < 1)) return null;
  if (partnerSubtypeId !== null && (!Number.isSafeInteger(partnerSubtypeId) || partnerSubtypeId < 1)) return null;
  const settlementMode: SettlementMode | null = paymentMode === "postpaid" ? "ad_hoc" : null;

  return {
    name,
    partnerType: partnerType as PartnerType,
    paymentMode: paymentMode as PaymentMode,
    settlementMode: settlementMode as SettlementMode | null,
    settlementRule: null,
    defaultPaymentTermDays: null,
    defaultFundAccountId,
    partnerSubtypeId,
    phone,
    contactName,
    memo,
    isActive: input.isActive,
    ledgerPartyId,
  };
}

// Subtype-management mutations (create/update) are intentionally separate from
// parsePartnerInput above -- they never touch a business_partners row.
const optionalName = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length <= 80 ? normalized || null : undefined;
};

export type PartnerSubtypeCreateInput = { partnerType: PartnerType; nameKo: string | null; nameVi: string | null; sortOrder: number };
export function parsePartnerSubtypeCreateInput(value: unknown): PartnerSubtypeCreateInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!PARTNER_TYPES.includes(input.partnerType as PartnerType)) return null;
  const nameKo = optionalName(input.nameKo);
  const nameVi = optionalName(input.nameVi);
  if (nameKo === undefined || nameVi === undefined) return null;
  if (!nameKo && !nameVi) return null;
  const sortOrder = input.sortOrder === null || input.sortOrder === undefined || input.sortOrder === "" ? 0 : Number(input.sortOrder);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) return null;
  return { partnerType: input.partnerType as PartnerType, nameKo, nameVi, sortOrder };
}

export type PartnerSubtypeUpdateInput = { nameKo: string | null; nameVi: string | null; sortOrder: number; isActive: boolean };
export function parsePartnerSubtypeUpdateInput(value: unknown): PartnerSubtypeUpdateInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const nameKo = optionalName(input.nameKo);
  const nameVi = optionalName(input.nameVi);
  if (nameKo === undefined || nameVi === undefined) return null;
  if (!nameKo && !nameVi) return null;
  const sortOrder = input.sortOrder === null || input.sortOrder === undefined || input.sortOrder === "" ? 0 : Number(input.sortOrder);
  if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) return null;
  if (typeof input.isActive !== "boolean") return null;
  return { nameKo, nameVi, sortOrder, isActive: input.isActive };
}
