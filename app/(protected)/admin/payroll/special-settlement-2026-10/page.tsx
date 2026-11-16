import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/server-auth";
import { PAYROLL_MANAGER_ROLES } from "@/lib/payroll/authorization";
import { payrollOverviewHref } from "@/lib/payroll/payroll-month-param";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// 2026-10 특별 정산은 배치로 완료되어 일회성 화면·API가 제거됐다. 과거 링크는 읽기 전용
// 일반 급여 상세(/admin/payroll/[runId])로 보낸다. 권한 확인 후에만 배치를 조회하며,
// 배치를 찾지 못하면 2026-10 급여관리 화면으로 보낸다(오류 화면 방치 없음).
export default async function LegacySpecialSettlement202610Page() {
  const auth = await requireRole(PAYROLL_MANAGER_ROLES);
  if (!auth.ok) redirect(auth.status === 401 ? "/login" : "/admin");
  const { data } = await supabaseServer.from("payroll_payment_batches").select("id").eq("payroll_month", "2026-10-01").maybeSingle();
  const runId = Number(data?.id);
  redirect(Number.isSafeInteger(runId) && runId > 0 ? `/admin/payroll/${runId}` : payrollOverviewHref("2026-10"));
}
