import type { PartnerType } from "./policy";

export const partnerTypeEmoji: Record<PartnerType, string> = {
  alcohol: "🍾",
  beverage: "🥤",
  food: "🛒",
  consumable: "🧻",
  equipment: "🧰",
  service: "🛎️",
  rent: "🏠",
  utilities: "⚡",
  other: "📦",
};

export function effectivePartnerEmoji(
  partnerType: PartnerType,
  subtype: { emoji: string | null } | null | undefined,
) {
  return subtype?.emoji?.trim() || partnerTypeEmoji[partnerType];
}
