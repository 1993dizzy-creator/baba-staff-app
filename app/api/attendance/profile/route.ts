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
import { calculateCombinedSalary } from "@/lib/payroll/compensation";
import { mapContract } from "@/lib/payroll/db-mappers";
import { supabaseServer } from "@/lib/supabase/server";

const PROFILE_FIELDS =
  "id,username,name,full_name,role,hire_date,termination_date,is_system_account,level_program_enabled,level_base_date_override";
const CONTRACT_FIELDS =
  "id,user_id,pay_type,calculation_basis,base_salary,fixed_raise_amount,standard_workdays,standard_minutes_per_day,time_block_minutes,rounding_mode,late_adjustment_mode,early_leave_adjustment_mode,overtime_mode,paid_leave_mode,effective_from,effective_to,revision";

export async function GET() {
  try {
    const auth = await requireAttendanceActor();
    if (!auth.ok) return attendanceAuthFailure(auth);

    const asOfDate = getAttendanceWorkDate();
    const [userResult, contractResult] = await Promise.all([
      supabaseServer.from("users").select(PROFILE_FIELDS).eq("id", auth.actor.id).maybeSingle(),
      supabaseServer
        .from("payroll_contract_versions")
        .select(CONTRACT_FIELDS)
        .eq("user_id", auth.actor.id)
        .lte("effective_from", asOfDate)
        .or(`effective_to.is.null,effective_to.gt.${asOfDate}`),
    ]);

    if (userResult.error || contractResult.error || !userResult.data) {
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
    const contracts = (contractResult.data ?? []).map((row) =>
      mapContract(row as Record<string, unknown>),
    );
    const contract = contracts.length === 1 ? contracts[0] : null;
    const compensation = contract
      ? calculateCombinedSalary(contract, employee.levelInfo)
      : null;

    return attendanceJson({
      ok: true,
      employee: {
        name: employee.name || employee.full_name || employee.username,
        role: employee.role,
        levelInfo: employee.levelInfo,
        currentSalary:
          contract && compensation && compensation.combinedSalary !== null
            ? { payType: contract.payType, combinedSalary: compensation.combinedSalary }
            : null,
      },
    });
  } catch (error) {
    console.error("attendance profile exception:", error);
    return attendanceJson({ ok: false, code: "ATTENDANCE_PROFILE_READ_FAILED" }, 500);
  }
}
