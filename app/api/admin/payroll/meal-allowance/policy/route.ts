import { supabaseServer } from "@/lib/supabase/server";
import { payrollJson, requirePayrollActor } from "@/lib/payroll/server";

export const dynamic = "force-dynamic";
const FIELDS = "id,daily_amount,effective_from,revision,created_by,created_at,note";

function map(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    dailyAmount: Number(row.daily_amount),
    effectiveFrom: String(row.effective_from),
    revision: Number(row.revision),
    createdBy: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    createdAt: row.created_at ? String(row.created_at) : null,
    note: row.note ? String(row.note) : null,
  };
}

// 특정 날짜 기준 가장 최근 유효 version(effective_from <= date, 동률이면 revision 최대).
function selectCurrent<T extends { effectiveFrom: string; revision: number }>(versions: T[], date: string) {
  return (
    versions
      .filter((version) => version.effectiveFrom <= date)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.revision - a.revision)[0] ?? null
  );
}

export async function GET() {
  const auth = await requirePayrollActor();
  if (auth.response) return auth.response;
  const { data, error } = await supabaseServer
    .from("payroll_meal_allowance_policy_versions")
    .select(FIELDS)
    .order("effective_from", { ascending: false })
    .order("revision", { ascending: false });
  if (error) return payrollJson({ ok: false, code: "MEAL_ALLOWANCE_POLICY_READ_FAILED" }, 500);
  const history = (data ?? []).map(map);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return payrollJson({ ok: true, current: selectCurrent(history, today), history });
}

export async function POST(request: Request) {
  const auth = await requirePayrollActor();
  if (auth.response || !auth.actor) return auth.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const dailyAmount = Number(body?.dailyAmount);
  const effectiveFrom = String(body?.effectiveFrom ?? "");
  if (
    !body ||
    !Number.isSafeInteger(dailyAmount) ||
    dailyAmount < 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)
  ) {
    return payrollJson({ ok: false, code: "INVALID_MEAL_ALLOWANCE_POLICY" }, 400);
  }
  const { data, error } = await supabaseServer.rpc("payroll_create_meal_allowance_policy_version_v1", {
    p_daily_amount: dailyAmount,
    p_effective_from: effectiveFrom,
    p_actor_user_id: auth.actor.id,
    p_note: typeof body.note === "string" ? body.note.trim() || null : null,
  });
  if (error) {
    const status = error.message.includes("PAYROLL_FORBIDDEN") ? 403 : 400;
    return payrollJson(
      { ok: false, code: status === 403 ? "FORBIDDEN" : "INVALID_MEAL_ALLOWANCE_POLICY" },
      status,
    );
  }
  return payrollJson({ ok: true, policy: map(data as Record<string, unknown>) }, 201);
}
