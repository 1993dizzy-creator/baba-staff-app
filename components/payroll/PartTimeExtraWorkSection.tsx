"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { PayrollOverviewEmployee } from "@/lib/payroll/overview";
import { formatVnd } from "@/lib/payroll/payroll-page-money";
import styles from "./PartTimeExtraWorkSection.module.css";

const formatTime = (value: string, lang: "ko" | "vi") => new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "ko-KR", {
  timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(value));
const formatDate = (value: string) => value.slice(5).replace("-", ".");
const hasValidDateTime = (value: string) => Boolean(value) && !Number.isNaN(Date.parse(value));

export default function PartTimeExtraWorkSection({ employee, month, lang, refresh }: {
  employee: PayrollOverviewEmployee;
  month: string;
  lang: "ko" | "vi";
  refresh: () => Promise<boolean>;
}) {
  const vi = lang === "vi";
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedAttendanceId, setExpandedAttendanceId] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestoreRef = useRef<{ listScrollTop: number; windowScrollY: number } | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const rows = employee.partTimeExtraWork;
  const approved = rows.filter(row => row.status === "approved");
  const approvedMinutes = approved.reduce((sum, row) => sum + row.candidateMinutes, 0);
  const reviewRequiredCount = rows.filter(row => row.status === "review_required").length;
  const staleCount = rows.filter(row => row.status === "stale").length;
  const hasUnresolved = reviewRequiredCount > 0 || staleCount > 0;
  const paid = employee.payment?.payment_status === "paid";
  const listId = `part-time-extra-work-list-${employee.userId}`;

  useLayoutEffect(() => {
    const saved = pendingScrollRestoreRef.current;
    if (!saved) return;
    const restore = () => {
      if (listRef.current) listRef.current.scrollTop = saved.listScrollTop;
      window.scrollTo({ top: saved.windowScrollY, left: window.scrollX });
    };
    restore();
    restoreFrameRef.current = window.requestAnimationFrame(() => {
      restore();
      pendingScrollRestoreRef.current = null;
      restoreFrameRef.current = null;
    });
    return () => {
      if (restoreFrameRef.current !== null) window.cancelAnimationFrame(restoreFrameRef.current);
    };
  }, [rows]);

  function captureScrollPosition() {
    pendingScrollRestoreRef.current = {
      listScrollTop: listRef.current?.scrollTop ?? 0,
      windowScrollY: window.scrollY,
    };
  }

  function toggleRow(attendanceRecordId: number) {
    setExpandedAttendanceId(current => current === attendanceRecordId ? null : attendanceRecordId);
  }

  async function decide(attendanceRecordId: number, decision: "approved" | "rejected", sourceHash: string) {
    captureScrollPosition();
    setBusyId(attendanceRecordId); setError("");
    try {
      const response = await fetch("/api/admin/payroll/part-time-extra-work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month, attendanceRecordId, decision, sourceHash }) });
      const body = await response.json().catch(() => ({})) as { code?: string };
      if (!response.ok) throw new Error(body.code === "PAYROLL_EXTRA_WORK_STALE" ? (vi ? "Dữ liệu đã thay đổi. Vui lòng kiểm tra lại." : "근태·계약·스케줄 또는 영업시간이 변경되었습니다. 다시 확인해주세요.") : body.code || (vi ? "Không thể lưu quyết định." : "승인 상태를 저장하지 못했습니다."));
      if (!(await refresh())) throw new Error(vi ? "Đã lưu nhưng không thể tải lại dữ liệu." : "저장했지만 급여 정보를 새로 불러오지 못했습니다.");
    } catch (reason) { pendingScrollRestoreRef.current = null; setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(null); }
  }

  async function cancel(attendanceRecordId: number) {
    const reason = window.prompt(vi ? "Nhập lý do hủy quyết định" : "결정 취소 사유를 입력해주세요.");
    if (!reason?.trim()) return;
    captureScrollPosition();
    setBusyId(attendanceRecordId); setError("");
    try {
      const response = await fetch("/api/admin/payroll/part-time-extra-work", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attendanceRecordId, cancellationReason: reason }) });
      const body = await response.json().catch(() => ({})) as { code?: string };
      if (!response.ok) throw new Error(body.code || (vi ? "Không thể hủy quyết định." : "결정을 취소하지 못했습니다."));
      if (!(await refresh())) throw new Error(vi ? "Đã hủy nhưng không thể tải lại dữ liệu." : "취소했지만 급여 정보를 새로 불러오지 못했습니다.");
    } catch (reason) { pendingScrollRestoreRef.current = null; setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusyId(null); }
  }

  return <section style={s.section} aria-label={vi ? "Làm thêm giờ" : "추가근무"}>
    <h4 style={s.title}>⏱️ {vi ? "Làm thêm giờ" : "추가근무"}</h4>
    <div style={s.summary}>
      <Metric label={vi ? "Thời gian đã duyệt" : "승인 시간"} value={`${approvedMinutes}${vi ? " phút" : "분"}`} />
      <Metric label={vi ? "Phụ cấp đã duyệt" : "승인 수당"} value={formatVnd(employee.amounts.partTimeExtraWorkAmount)} />
      {reviewRequiredCount > 0 && <Metric label={vi ? "Chưa duyệt" : "미검토"} value={`${reviewRequiredCount}${vi ? " mục" : "건"}`} />}
      {staleCount > 0 && <Metric label={vi ? "Cần duyệt lại" : "재검토"} value={`${staleCount}${vi ? " mục" : "건"}`} />}
    </div>
    {hasUnresolved && <p role="alert" style={s.warning}>{vi ? "Không thể trả lương: cần duyệt các mục chưa xử lý hoặc duyệt lại mục đã thay đổi." : "급여 지급 불가: 미검토 건을 승인·거절하고, 변경된(stale) 건은 다시 판단해야 합니다."}</p>}
    {rows.length === 0 ? <small style={s.help}>{vi ? "Không có thời gian làm thêm đủ điều kiện trong tháng này." : "이번 달 지급 후보 추가근무가 없습니다."}</small> : <>
      <button type="button" aria-expanded={isExpanded} aria-controls={listId} style={s.toggle} onClick={() => setIsExpanded(expanded => !expanded)}>
        {isExpanded ? (vi ? "Thu gọn toàn bộ" : "전체 내역 접기") : (vi ? `Xem toàn bộ (${rows.length} mục)` : `전체 내역 펼치기 (${rows.length}건)`)}
      </button>
      {isExpanded && <div ref={listRef} id={listId} className={styles.list} data-extra-work-list>{rows.map(row => {
        const disabled = paid || busyId === row.attendanceRecordId;
        const rowExpanded = expandedAttendanceId === row.attendanceRecordId;
        const detailId = `extra-work-detail-${employee.userId}-${row.attendanceRecordId}`;
        const excludedMinutes = row.excludedBeforeOpenMinutes + row.excludedAfterCloseMinutes;
        const excludedParts = [
          row.excludedBeforeOpenMinutes > 0 ? `${vi ? "trước giờ mở cửa " : "오픈 전 "}${row.excludedBeforeOpenMinutes}${vi ? " phút" : "분"}` : "",
          row.excludedAfterCloseMinutes > 0 ? `${vi ? "sau giờ đóng cửa " : "마감 후 "}${row.excludedAfterCloseMinutes}${vi ? " phút" : "분"}` : "",
        ].filter(Boolean);
        return <article key={row.attendanceRecordId} className={styles.item} data-extra-work-item data-expanded={rowExpanded} onClick={() => toggleRow(row.attendanceRecordId)}>
      <button type="button" className={styles.summaryToggle} aria-expanded={rowExpanded} aria-controls={detailId}>
        <span className={styles.summaryMain}>
          <b className={styles.date}>{formatDate(row.businessDate)}</b>
          <b className={styles.extra}>+{row.candidateMinutes}{vi ? " phút" : "분"} · {formatVnd(row.candidateAmount)}</b>
        </span>
        <span className={styles.rowChevron} aria-hidden="true">{rowExpanded ? "▾" : "▸"}</span>
      </button>
      <div className={styles.controls} data-extra-work-controls>
        <Status status={row.status} vi={vi} />
        <div className={styles.actions} onClick={(event) => event.stopPropagation()}>
          {(row.status === "review_required" || row.status === "stale") ? <><button type="button" disabled={disabled} className={`${styles.actionButton} ${styles.approve} ${disabled ? styles.disabledButton : styles.enabledButton}`} onClick={(event) => { event.stopPropagation(); void decide(row.attendanceRecordId, "approved", row.sourceHash); }}>{vi ? "Duyệt" : "승인"}</button><button type="button" disabled={disabled} className={`${styles.actionButton} ${styles.reject} ${disabled ? styles.disabledButton : styles.enabledButton}`} onClick={(event) => { event.stopPropagation(); void decide(row.attendanceRecordId, "rejected", row.sourceHash); }}>{vi ? "Từ chối" : "거절"}</button></> : <button type="button" disabled={disabled} className={`${styles.actionButton} ${styles.cancel} ${disabled ? styles.disabledButton : styles.enabledButton}`} onClick={(event) => { event.stopPropagation(); void cancel(row.attendanceRecordId); }}>{vi ? "Hủy quyết định" : "결정 취소"}</button>}
        </div>
      </div>
      {rowExpanded && <div id={detailId} className={styles.info} data-extra-work-info>
        {hasValidDateTime(row.checkInAt) && hasValidDateTime(row.checkOutAt) && <DetailLine label={vi ? "Chấm công" : "출퇴근"} value={`${formatTime(row.checkInAt, lang)}–${formatTime(row.checkOutAt, lang)}`} />}
        {row.scheduleStartTime && row.scheduleEndTime && <DetailLine label={vi ? "Giờ làm" : "근무시간"} value={`${row.scheduleStartTime}–${row.scheduleEndTime}`} />}
        {row.beforeScheduleMinutes > 0 && <DetailLine accent label={vi ? "Trước ca" : "출근 전"} value={`+${row.beforeScheduleMinutes}${vi ? " phút" : "분"}`} />}
        {row.afterScheduleMinutes > 0 && <DetailLine accent label={vi ? "Sau ca" : "퇴근 후"} value={`+${row.afterScheduleMinutes}${vi ? " phút" : "분"}`} />}
        {excludedMinutes > 0 && <DetailLine wide label={vi ? "Loại trừ" : "제외시간"} value={`${excludedMinutes}${vi ? " phút" : "분"}${excludedParts.length > 0 ? ` (${excludedParts.join(" · ")})` : ""}`} />}
      </div>}
    </article>})}</div>}
    </>}
    {paid && <small style={s.help}>{vi ? "Đã trả lương nên không thể thay đổi quyết định." : "지급 완료 직원은 결정을 변경할 수 없습니다."}</small>}
    {error && <p role="alert" style={s.error}>{error}</p>}
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div style={s.metric}><span>{label}</span><b>{value}</b></div>; }
function DetailLine({ label, value, accent = false, wide = false }: { label: string; value: string; accent?: boolean; wide?: boolean }) {
  const className = [styles.detailLine, accent ? styles.detailAccent : "", wide ? styles.detailWide : ""].filter(Boolean).join(" ");
  return <span className={className}><span>{label}</span><b>{value}</b></span>;
}
function Status({ status, vi }: { status: "review_required" | "stale" | "approved" | "rejected"; vi: boolean }) {
  const label = vi ? { review_required: "Chưa duyệt", stale: "Cần duyệt lại", approved: "Đã duyệt", rejected: "Đã từ chối" }[status] : { review_required: "미검토", stale: "변경됨·재검토", approved: "승인", rejected: "거절" }[status];
  return <span className={`${styles.badge} ${status === "approved" ? styles.approvedBadge : status === "rejected" ? styles.rejectedBadge : styles.pendingBadge}`}>{label}</span>;
}

const s = {
  section: { display: "grid", gap: 7, paddingTop: 11, borderTop: "1px solid #f1f5f9" },
  title: { margin: 0, fontSize: 12, color: "#475569" }, summary: { display: "grid", gap: 4, padding: 8, borderRadius: 8, background: "#eff6ff" },
  metric: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11 }, warning: { margin: 0, padding: 8, borderRadius: 8, background: "#fff7ed", color: "#9a3412", lineHeight: 1.4 },
  help: { color: "#64748b", lineHeight: 1.4 }, toggle: { justifySelf: "start", padding: "3px 7px", border: "1px solid #cbd5e1", borderRadius: 5, background: "#fff", color: "#475569", fontSize: 10, fontWeight: 700, cursor: "pointer" }, error: { margin: 0, padding: 8, borderRadius: 8, background: "#fef2f2", color: "#b91c1c" },
} satisfies Record<string, CSSProperties>;
