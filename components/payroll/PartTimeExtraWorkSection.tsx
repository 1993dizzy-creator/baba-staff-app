"use client";

import { useState, type CSSProperties } from "react";
import type { PayrollOverviewEmployee } from "@/lib/payroll/overview";
import { formatVnd } from "@/lib/payroll/payroll-page-money";

const formatTime = (value: string, lang: "ko" | "vi") => new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "ko-KR", {
  timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(value));
const formatDate = (value: string) => value.slice(5).replace("-", ".");

export default function PartTimeExtraWorkSection({ employee, month, lang, refresh }: {
  employee: PayrollOverviewEmployee;
  month: string;
  lang: "ko" | "vi";
  refresh: () => Promise<boolean>;
}) {
  const vi = lang === "vi";
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const rows = employee.partTimeExtraWork;
  const candidateMinutes = rows.reduce((sum, row) => sum + row.candidateMinutes, 0);
  const approved = rows.filter(row => row.status === "approved");
  const approvedMinutes = approved.reduce((sum, row) => sum + row.candidateMinutes, 0);
  const unresolved = rows.filter(row => row.status === "review_required" || row.status === "stale");
  const paid = employee.payment?.payment_status === "paid";

  async function decide(attendanceRecordId: number, decision: "approved" | "rejected", sourceHash: string) {
    setBusyId(attendanceRecordId); setError("");
    try {
      const response = await fetch("/api/admin/payroll/part-time-extra-work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, attendanceRecordId, decision, sourceHash }) });
      const body = await response.json().catch(() => ({})) as { code?: string };
      if (!response.ok) throw new Error(body.code === "PAYROLL_EXTRA_WORK_STALE" ? (vi ? "Dữ liệu đã thay đổi. Vui lòng kiểm tra lại." : "근태·계약·스케줄 또는 영업시간이 변경되었습니다. 다시 확인해주세요.") : body.code || (vi ? "Không thể lưu quyết định." : "승인 상태를 저장하지 못했습니다."));
      if (!(await refresh())) throw new Error(vi ? "Đã lưu nhưng không thể tải lại dữ liệu." : "저장했지만 급여 정보를 새로 불러오지 못했습니다.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(null); }
  }

  async function cancel(attendanceRecordId: number) {
    const reason = window.prompt(vi ? "Nhập lý do hủy quyết định" : "결정 취소 사유를 입력해주세요.");
    if (!reason?.trim()) return;
    setBusyId(attendanceRecordId); setError("");
    try {
      const response = await fetch("/api/admin/payroll/part-time-extra-work", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attendanceRecordId, cancellationReason: reason }) });
      const body = await response.json().catch(() => ({})) as { code?: string };
      if (!response.ok) throw new Error(body.code || (vi ? "Không thể hủy quyết định." : "결정을 취소하지 못했습니다."));
      if (!(await refresh())) throw new Error(vi ? "Đã hủy nhưng không thể tải lại dữ liệu." : "취소했지만 급여 정보를 새로 불러오지 못했습니다.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(null); }
  }

  return <section style={s.section} aria-label={vi ? "Làm thêm part-time" : "파트타임 추가근무"}>
    <h4 style={s.title}>⏱️ {vi ? "Làm thêm part-time" : "파트타임 추가근무"}</h4>
    <div style={s.summary}>
      <Metric label={vi ? "Thời gian ứng viên" : "후보 시간"} value={`${candidateMinutes}${vi ? " phút" : "분"}`} />
      <Metric label={vi ? "Thời gian đã duyệt" : "승인 시간"} value={`${approvedMinutes}${vi ? " phút" : "분"}`} />
      <Metric label={vi ? "Phụ cấp đã duyệt" : "승인 수당"} value={formatVnd(employee.amounts.partTimeExtraWorkAmount)} />
      <Metric label={vi ? "Chưa xử lý / cần xem lại" : "미검토·재검토"} value={`${unresolved.length}${vi ? " mục" : "건"}`} />
    </div>
    {unresolved.length > 0 && <p role="alert" style={s.warning}>{vi ? "Không thể trả lương: cần duyệt các mục chưa xử lý hoặc duyệt lại mục đã thay đổi." : "급여 지급 불가: 미검토 건을 승인·거절하고, 변경된(stale) 건은 다시 판단해야 합니다."}</p>}
    {rows.length === 0 ? <small style={s.help}>{vi ? "Không có thời gian làm thêm đủ điều kiện trong tháng này." : "이번 달 지급 후보 추가근무가 없습니다."}</small> : <div style={s.list}>{rows.map(row => <article key={row.attendanceRecordId} style={s.item}>
      <b style={s.date}>{formatDate(row.businessDate)}</b>
      <div style={s.info}>
        <span style={s.infoItem}><span style={s.infoLabel}>{vi ? "Chấm công" : "출퇴근"}</span> {formatTime(row.checkInAt, lang)}–{formatTime(row.checkOutAt, lang)}</span>
        <span style={s.infoItem}><span style={s.infoLabel}>{vi ? "Giờ làm" : "근무시간"}</span> {row.scheduleStartTime}–{row.scheduleEndTime}</span>
        <b style={s.extra}>{vi ? "Làm thêm" : "추가"} +{row.candidateMinutes}{vi ? " phút" : "분"} · {formatVnd(row.candidateAmount)}</b>
        <details style={s.details}>
          <summary style={s.detailsSummary}>{vi ? "Chi tiết tính" : "계산 상세"}</summary>
          <span style={s.detailsText}>{vi ? `Làm thêm trước giờ vào ca ${row.beforeScheduleMinutes} phút · Làm thêm sau giờ tan ca ${row.afterScheduleMinutes} phút · Loại trừ ${row.excludedBeforeOpenMinutes + row.excludedAfterCloseMinutes} phút (${row.excludedBeforeOpenMinutes}/${row.excludedAfterCloseMinutes})` : `출근 전 추가 ${row.beforeScheduleMinutes}분 · 퇴근 후 추가 ${row.afterScheduleMinutes}분 · 제외 ${row.excludedBeforeOpenMinutes + row.excludedAfterCloseMinutes}분 (${row.excludedBeforeOpenMinutes}/${row.excludedAfterCloseMinutes})`}</span>
        </details>
      </div>
      <Status status={row.status} vi={vi} />
      <div style={s.actions}>
        {(row.status === "review_required" || row.status === "stale") ? <><button type="button" disabled={paid || busyId === row.attendanceRecordId} style={s.approve} onClick={() => decide(row.attendanceRecordId, "approved", row.sourceHash)}>{vi ? "Duyệt" : "승인"}</button><button type="button" disabled={paid || busyId === row.attendanceRecordId} style={s.reject} onClick={() => decide(row.attendanceRecordId, "rejected", row.sourceHash)}>{vi ? "Từ chối" : "거절"}</button></> : <button type="button" disabled={paid || busyId === row.attendanceRecordId} style={s.cancel} onClick={() => cancel(row.attendanceRecordId)}>{vi ? "Hủy quyết định" : "결정 취소"}</button>}
      </div>
    </article>)}</div>}
    {paid && <small style={s.help}>{vi ? "Đã trả lương nên không thể thay đổi quyết định." : "지급 완료 직원은 결정을 변경할 수 없습니다."}</small>}
    {error && <p role="alert" style={s.error}>{error}</p>}
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div style={s.metric}><span>{label}</span><b>{value}</b></div>; }
function Status({ status, vi }: { status: "review_required" | "stale" | "approved" | "rejected"; vi: boolean }) {
  const label = vi ? { review_required: "Chưa duyệt", stale: "Cần duyệt lại", approved: "Đã duyệt", rejected: "Đã từ chối" }[status] : { review_required: "미검토", stale: "변경됨·재검토", approved: "승인", rejected: "거절" }[status];
  return <span style={{ ...s.badge, ...(status === "approved" ? s.approvedBadge : status === "rejected" ? s.rejectedBadge : s.pendingBadge) }}>{label}</span>;
}

const s = {
  section: { display: "grid", gap: 7, paddingTop: 11, borderTop: "1px solid #f1f5f9" },
  title: { margin: 0, fontSize: 12, color: "#475569" }, summary: { display: "grid", gap: 4, padding: 8, borderRadius: 8, background: "#eff6ff" },
  metric: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11 }, warning: { margin: 0, padding: 8, borderRadius: 8, background: "#fff7ed", color: "#9a3412", lineHeight: 1.4 },
  help: { color: "#64748b", lineHeight: 1.4 }, list: { display: "grid", gap: 3 }, item: { display: "grid", gridTemplateColumns: "36px minmax(0,1fr) auto auto", gap: 5, alignItems: "center", minHeight: 28, padding: "4px 6px", border: "1px solid #e2e8f0", borderRadius: 7, background: "#fff" },
  date: { fontSize: 10.5, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", color: "#334155" }, info: { minWidth: 0, display: "flex", alignItems: "center", columnGap: 8, rowGap: 2, flexWrap: "wrap", lineHeight: 1.25 }, infoItem: { whiteSpace: "nowrap", fontSize: 10.5, color: "#334155" }, infoLabel: { color: "#64748b" }, extra: { whiteSpace: "nowrap", fontSize: 10.5, color: "#1d4ed8" },
  details: { fontSize: 9.5, color: "#64748b" }, detailsSummary: { cursor: "pointer", whiteSpace: "nowrap" }, detailsText: { display: "block", marginTop: 3, lineHeight: 1.35 }, badge: { padding: "1px 5px", borderRadius: 999, fontSize: 8.5, lineHeight: 1.5, fontWeight: 800, whiteSpace: "nowrap" }, approvedBadge: { background: "#dcfce7", color: "#166534" }, rejectedBadge: { background: "#f1f5f9", color: "#475569" }, pendingBadge: { background: "#ffedd5", color: "#9a3412" },
  actions: { display: "flex", gap: 3, justifyContent: "flex-end", whiteSpace: "nowrap" }, approve: { minHeight: 24, padding: "3px 7px", border: 0, borderRadius: 5, background: "#166534", color: "#fff", fontSize: 10, fontWeight: 800 }, reject: { minHeight: 24, padding: "3px 7px", border: 0, borderRadius: 5, background: "#b91c1c", color: "#fff", fontSize: 10, fontWeight: 800 }, cancel: { minHeight: 24, padding: "3px 7px", border: "1px solid #cbd5e1", borderRadius: 5, background: "#fff", color: "#334155", fontSize: 10, fontWeight: 800 }, error: { margin: 0, padding: 8, borderRadius: 8, background: "#fef2f2", color: "#b91c1c" },
} satisfies Record<string, CSSProperties>;
