import {
  attendanceAuthFailure,
  attendanceJson,
  requireAttendanceActor,
} from "@/lib/attendance/server-api";
import { selectAttendancePayrollSummary } from "@/lib/payroll/attendance-self-summary";
import { validPayrollMonth } from "@/lib/payroll/monthly-run";
import { loadPayrollOverview } from "@/lib/payroll/overview-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAttendanceActor();
  if (!auth.ok) return attendanceAuthFailure(auth);

  const month = validPayrollMonth(new URL(request.url).searchParams.get("month"));
  if (!month) return attendanceJson({ ok: false, code: "INVALID_MONTH" }, 400);

  try {
    const overview = await loadPayrollOverview(month, {
      userId: auth.actor.id,
    });
    const data = selectAttendancePayrollSummary(
      overview.employees,
      auth.actor.id,
    );

    return attendanceJson({
      ok: true,
      month,
      perfectAttendanceCurrent: data?.perfectAttendanceCurrent ?? false,
      summary: data?.summary ?? null,
      incentives: data?.incentives ?? [],
      penalties: data?.penalties ?? [],
    });
  } catch (error) {
    console.error("attendance payroll summary exception:", error);
    return attendanceJson(
      { ok: false, code: "ATTENDANCE_PAYROLL_SUMMARY_READ_FAILED" },
      500,
    );
  }
}
