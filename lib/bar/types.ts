import type { BarColorKey } from "@/lib/bar/colors";

export type BarAssignee = {
  id: number;
  name: string;
  isActive: boolean;
  colorKey: BarColorKey | null;
};

export type BarZoneRecord = {
  id: number;
  code: string;
  kind: "storage" | "equipment";
  selectableForKeeping: boolean;
  noteKo: string | null;
  noteVi: string | null;
  imagePath: string | null;
  imageUrl: string | null;
  imageUpdatedAt: string | null;
  assignee: BarAssignee | null;
  isActive: boolean;
  version: number;
  updatedAt: string;
};

export type BarStaffOption = {
  id: number;
  name: string;
  role: string;
  part: string;
  colorKey: BarColorKey | null;
};

export type BarActivityLog = {
  id: number;
  entityType: string;
  entityId: number;
  entityCode: string | null;
  actionType: string;
  actorName: string;
  createdAt: string;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
};
