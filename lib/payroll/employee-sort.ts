import { getPartMeta } from "@/lib/common/parts";
import { getPositionRank } from "@/lib/common/positions";

export type PayrollEmployeeSortValue = {
  id?: number;
  userId?: number;
  name?: string | null;
  username?: string | null;
  part?: string | null;
  position?: string | null;
};

export function comparePayrollEmployees(a: PayrollEmployeeSortValue, b: PayrollEmployeeSortValue) {
  const part = getPartMeta(a.part).rank - getPartMeta(b.part).rank;
  if (part) return part;
  const position = getPositionRank(a.position) - getPositionRank(b.position);
  if (position) return position;
  const name = (a.name || a.username || "").localeCompare(b.name || b.username || "", undefined, { sensitivity: "base" });
  if (name) return name;
  return Number(a.id ?? a.userId ?? 0) - Number(b.id ?? b.userId ?? 0);
}
