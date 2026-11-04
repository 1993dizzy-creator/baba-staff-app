// 급여 지급 요청의 응답을 받지 못했을 때(네트워크 오류·응답 유실·게이트웨이 오류), 기존 지급 내역
// 조회 API(지급 batch 목록 → batch별 직원 지급 기록)로 실제 처리 여부를 확인한다.
// 읽기 전용 조회이며 지급 요청을 다시 보내지 않는다.
//   "paid"   — 해당 월 batch에 이 직원의 지급 완료 기록이 있다
//   "unpaid" — 해당 월 batch가 없거나, 이 직원의 지급 완료 기록이 없다
//   null     — 조회 실패(처리 여부를 알 수 없음)

type FetchLike = (input: string, init?: { cache?: "no-store" }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export async function lookupEmployeePaymentStatus(month: string, userId: number, fetcher: FetchLike = fetch as unknown as FetchLike): Promise<"paid" | "unpaid" | null> {
  try {
    const runsResponse = await fetcher("/api/admin/payroll/runs", { cache: "no-store" });
    const runsData = await runsResponse.json().catch(() => null) as { ok?: boolean; runs?: unknown } | null;
    if (!runsResponse.ok || !runsData?.ok || !Array.isArray(runsData.runs)) return null;
    const run = (runsData.runs as Array<{ id: number; payroll_month: string }>).find((item) => String(item.payroll_month).slice(0, 7) === month);
    if (!run) return "unpaid";
    const runResponse = await fetcher(`/api/admin/payroll/runs/${run.id}`, { cache: "no-store" });
    const runData = await runResponse.json().catch(() => null) as { ok?: boolean; employees?: unknown } | null;
    if (!runResponse.ok || !runData?.ok || !Array.isArray(runData.employees)) return null;
    const row = (runData.employees as Array<{ user_id: number; payment_status: string }>).find((item) => Number(item.user_id) === userId);
    return row?.payment_status === "paid" ? "paid" : "unpaid";
  } catch {
    return null;
  }
}
