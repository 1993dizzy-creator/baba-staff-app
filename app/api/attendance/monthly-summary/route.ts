import { attendanceAuthFailure, attendanceJson, requireAttendanceActor } from "@/lib/attendance/server-api";
import { loadMonthlyAttendanceStandings } from "@/lib/attendance/monthly-standing-server";
import { validPayrollMonth } from "@/lib/payroll/monthly-run";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAttendanceActor();
  if (!auth.ok) return attendanceAuthFailure(auth);

  const searchParams = new URL(request.url).searchParams;
  const month = validPayrollMonth(searchParams.get("month"));
  if (!month) return attendanceJson({ ok: false, code: "INVALID_MONTH" }, 400);

  const userIdParam = searchParams.get("userId");
  if (
    userIdParam !== null &&
    (!/^\d+$/.test(userIdParam) ||
      !Number.isSafeInteger(Number(userIdParam)) ||
      Number(userIdParam) < 1)
  ) {
    return attendanceJson({ ok: false, code: "INVALID_USER_ID" }, 400);
  }
  const userId = userIdParam === null ? undefined : Number(userIdParam);

  try {
    const result = await loadMonthlyAttendanceStandings(month, { userId });
    const summaries = [...result.standings.entries()].map(([summaryUserId, standing]) => ({
      userId: summaryUserId,
      actualWorkDays: standing.actualWorkDays,
      lateCount: standing.lateCount,
      earlyLeaveCount: standing.earlyLeaveCount,
      unauthorizedAbsenceCount: standing.unauthorizedAbsenceCount,
      blockingCount: standing.blockingCount,
      perfectAttendanceCurrent: standing.perfectAttendanceCurrent,
    }));
    return attendanceJson({ ok: true, month, asOfDate: result.asOfDate, summaries });
  } catch {
    return attendanceJson({ ok: false, code: "MONTHLY_ATTENDANCE_SUMMARY_READ_FAILED" }, 500);
  }
}
