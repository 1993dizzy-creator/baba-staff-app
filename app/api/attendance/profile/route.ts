import {
  attendanceAuthFailure,
  attendanceJson,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";
import { getAttendanceWorkDate } from "@/lib/attendance/time";
import {
  applyEmployeeLevelProgramVersion,
  loadEmployeeLevelProgramVersions,
  withEmployeeLevelInfo,
  type EmployeeLevelUser,
} from "@/lib/employee-level/server";
import { supabaseServer } from "@/lib/supabase/server";

const PROFILE_FIELDS =
  "id,username,name,full_name,role,hire_date,termination_date,is_system_account,level_program_enabled,level_base_date_override";
export async function GET() {
  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);

    const asOfDate = getAttendanceWorkDate();
    const userResult = await supabaseServer
      .from("users")
      .select(PROFILE_FIELDS)
      .eq("id", auth.actor.id)
      .maybeSingle();

    if (userResult.error || !userResult.data) {
      throw new Error("ATTENDANCE_PROFILE_READ_FAILED");
    }

    const user = userResult.data as EmployeeLevelUser & {
      id: number;
      username: string;
      name: string | null;
      full_name: string | null;
    };
    const versions = await loadEmployeeLevelProgramVersions([auth.actor.id], asOfDate);
    const employee = withEmployeeLevelInfo(
      applyEmployeeLevelProgramVersion(user, versions.get(auth.actor.id)),
      asOfDate,
    );
    return attendanceJson({
      ok: true,
      employee: {
        name: employee.name || employee.full_name || employee.username,
        role: employee.role,
        levelInfo: employee.levelInfo,
      },
    });
  } catch (error) {
    console.error("attendance profile exception:", error);
    return attendanceJson({ ok: false, code: "ATTENDANCE_PROFILE_READ_FAILED" }, 500);
  }
}
