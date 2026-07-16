import type { KeepingCloseReason, KeepingStatus } from "@/lib/bar/keeping";

export type KeepingCapabilities = { view: boolean; manage: boolean; reactivate: boolean; editClosed: boolean };
export type BarKeeping = {
  id: number; customerName: string; customerContact: string | null; customerIdentifier: string | null; liquorName: string; liquorSource: "inventory" | "external" | null; inventoryItemId: number | null; useCount: number; note: string | null;
  zoneCode: string; zoneLabelKo: string; zoneLabelVi: string; zoneIsActive: boolean;
  status: KeepingStatus; closeReason: KeepingCloseReason | null; closeNote: string | null;
  remainingPercent: number; imageUrl: string | null; thumbnailUrl: string | null; imageUpdatedAt: string | null;
  storedAt: string; lastUsedAt: string | null; expiresAt: string | null; closedAt: string | null;
  version: number; createdAt: string; updatedAt: string; isExpirySoon: boolean; isExpired: boolean;
};

export type BarKeepingListItem = Pick<BarKeeping, "id" | "customerName" | "liquorName" | "liquorSource" | "useCount" | "zoneCode" | "status" | "closeReason" | "remainingPercent" | "thumbnailUrl" | "storedAt" | "lastUsedAt" | "expiresAt" | "closedAt" | "updatedAt" | "isExpirySoon" | "isExpired"> & { customerIdentifierMasked: string | null };
