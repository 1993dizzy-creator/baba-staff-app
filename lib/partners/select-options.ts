// Shared display rules for every 거래처 select (장부작성, 재고관리, 일자별재고, 빠른 구매):
// the 장부 group order and KO/VI labels, name order within a group, and the emoji
// (subtype emoji first, else the partner type's). Each screen keeps its own option
// values and save logic; only the options' grouping and labels come from here.
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import { effectivePartnerEmoji, partnerTypeEmoji } from "./emoji.ts";
// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import { groupManualEntryPartners } from "../ledger/manual-entry-policy.ts";
import type { PartnerType } from "./policy";

export type PartnerSelectOption = { id: number; name: string; partnerType: string | null; emoji: string; isActive: boolean };

// Read-only partner columns a select needs; subtypes come from one parallel read.
export const PARTNER_OPTION_COLUMNS = "id,name,partner_type,partner_subtype_id,is_active";
export const PARTNER_SUBTYPE_EMOJI_COLUMNS = "id,emoji";

type PartnerRow = { id: number | string; name: string; partner_type: string | null; partner_subtype_id: number | string | null; is_active?: boolean | null };
type SubtypeRow = { id: number | string; emoji: string | null };

export function partnerSelectOptions(partners: readonly PartnerRow[], subtypes: readonly SubtypeRow[]): PartnerSelectOption[] {
  const subtypeById = new Map(subtypes.map(subtype => [Number(subtype.id), subtype]));
  return partners.map(partner => ({
    id: Number(partner.id),
    name: partner.name,
    partnerType: partner.partner_type,
    emoji: effectivePartnerEmoji(partnerTypeOrOther(partner.partner_type), partner.partner_subtype_id === null ? null : subtypeById.get(Number(partner.partner_subtype_id))),
    isActive: partner.is_active !== false,
  }));
}

function partnerTypeOrOther(partnerType: string | null | undefined): PartnerType {
  return partnerType != null && partnerType in partnerTypeEmoji ? partnerType as PartnerType : "other";
}

// Active partners in the 장부 group order, each group sorted by name.
export function partnerSelectGroups<T extends { name: string; partnerType: string | null; isActive?: boolean; emoji?: string | null }>(partners: readonly T[], lang: "ko" | "vi") {
  return groupManualEntryPartners(partners.map(partner => ({ ...partner, isActive: partner.isActive !== false })), lang) as Array<{ group: string; label: string; partners: Array<T & { isActive: boolean }> }>;
}

export function partnerOptionLabel(partner: { name: string; partnerType: string | null; emoji?: string | null }) {
  return `${partner.emoji?.trim() || partnerTypeEmoji[partnerTypeOrOther(partner.partnerType)]} ${partner.name}`;
}
