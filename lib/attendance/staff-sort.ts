import { getPartMeta } from "@/lib/common/parts";
import { getEmployeeRoleRank } from "@/lib/common/roles";

// Preserve the staff screen's normalized part, role and name ordering.
export function compareAttendanceStaff(a: { part: string | null; role: string | null; name: string }, b: { part: string | null; role: string | null; name: string }) {
  return getPartMeta(a.part).rank - getPartMeta(b.part).rank
    || getEmployeeRoleRank(a.role) - getEmployeeRoleRank(b.role)
    || a.name.localeCompare(b.name);
}
