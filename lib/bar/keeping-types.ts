import type { KeepingCloseReason, KeepingStatus } from "@/lib/bar/keeping";

export type KeepingCapabilities = { view: boolean; manage: boolean; reactivate: boolean; editClosed: boolean; delete: boolean };
export type BarKeeping = {
  id: number; customerName: string; customerContact: string | null; customerIdentifier: string | null; liquorName: string; liquorNameKo: string | null; liquorNameVi: string | null; liquorSource: "inventory" | "external" | null; inventoryItemId: number | null; useCount: number; note: string | null;
  zoneCode: string; zoneLabelKo: string; zoneLabelVi: string; zoneIsActive: boolean;
  status: KeepingStatus; closeReason: KeepingCloseReason | null; closeNote: string | null;
  remainingPercent: number; imageUrl: string | null; thumbnailUrl: string | null; imageUpdatedAt: string | null;
  storedAt: string; lastUsedAt: string | null; expiresAt: string | null; closedAt: string | null;
  version: number; createdAt: string; updatedAt: string; isExpirySoon: boolean; isExpired: boolean;
};

export type BarKeepingListItem = Pick<BarKeeping, "id" | "customerName" | "liquorName" | "liquorNameKo" | "liquorNameVi" | "liquorSource" | "useCount" | "zoneCode" | "status" | "closeReason" | "remainingPercent" | "thumbnailUrl" | "storedAt" | "lastUsedAt" | "expiresAt" | "closedAt" | "updatedAt" | "isExpirySoon" | "isExpired"> & { customerIdentifierMasked: string | null };

export const keepingLiquorName = (item: Pick<BarKeeping, "liquorName" | "liquorNameKo" | "liquorNameVi" | "liquorSource">, lang: "ko" | "vi") =>
  item.liquorSource === "inventory"
    ? (lang === "vi" ? item.liquorNameVi || item.liquorNameKo : item.liquorNameKo || item.liquorNameVi) || item.liquorName
    : item.liquorName;
