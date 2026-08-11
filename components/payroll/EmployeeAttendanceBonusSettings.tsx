"use client";

/* eslint-disable react-hooks/set-state-in-effect */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  attendanceBonusMonthlyStatus,
  type AttendanceBonusMonthlyStanding,
} from "@/lib/payroll/attendance-bonus-status";

type EligibilityVersion = {
  id: number;
  isEligible: boolean;
  effectiveMonth: string;
  revision: number;
  note: string | null;
};

type AttendanceBonusPolicy = {
  effectiveMonth: string;
  minimumActualWorkdays: number;
  allowedLateCount: number;
  allowedEarlyLeaveCount: number;
  bonusAmount: number;
};

type AttendanceBonusState = {
  current: EligibilityVersion | null;
  history: EligibilityVersion[];
  attendanceTrackingEnabled: boolean;
  policy: AttendanceBonusPolicy | null;
  payrollMonth: string;
  monthClosed: boolean;
  standing: AttendanceBonusMonthlyStanding | null;
};

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()).slice(0, 7);
}

function formatVnd(amount: number) {
  return `${amount.toLocaleString("en-US")} VND`;
}

export default function EmployeeAttendanceBonusSettings({
  userId,
  vi,
}: {
  userId: number;
  vi: boolean;
}) {
  const mounted = useRef(true);
  const [state, setState] = useState<AttendanceBonusState | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [isEligible, setEligible] = useState(false);
  const [effectiveMonth, setEffectiveMonth] = useState(currentMonth);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const resetForm = useCallback((current: EligibilityVersion | null) => {
    setEligible(current?.isEligible ?? false);
    setEffectiveMonth(currentMonth());
    setNote("");
    setError("");
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const payrollMonth = currentMonth();
      const [eligibilityResponse, policyResponse, summaryResponse] = await Promise.all([
        fetch(`/api/admin/payroll/attendance-bonus/eligibility?userId=${userId}`, { cache: "no-store", signal }),
        fetch("/api/admin/payroll/attendance-bonus/policy", { cache: "no-store", signal }),
        fetch(`/api/attendance/monthly-summary?month=${payrollMonth}`, { cache: "no-store", signal }),
      ]);
      if (signal?.aborted || !mounted.current) return;
      const [eligibilityData, policyData, summaryData] = await Promise.all([
        eligibilityResponse.json(),
        policyResponse.json(),
        summaryResponse.json(),
      ]);
      if (signal?.aborted || !mounted.current) return;
      if (!eligibilityResponse.ok || !policyResponse.ok || !summaryResponse.ok) {
        setError(vi ? "Không thể tải cài đặt thưởng chuyên cần." : "개근 보너스 설정을 불러오지 못했습니다.");
        return;
      }
      const next: AttendanceBonusState = {
        current: eligibilityData.current ?? null,
        history: eligibilityData.history ?? [],
        attendanceTrackingEnabled: eligibilityData.attendanceTrackingEnabled === true,
        policy: policyData.current ?? null,
        payrollMonth,
        monthClosed: String(summaryData.month) < currentMonth(),
        standing: summaryData.summaries?.find((item: { userId: number }) => item.userId === userId) ?? null,
      };
      setState(next);
      resetForm(next.current);
    } catch (loadError: unknown) {
      if (signal?.aborted || !mounted.current || (loadError instanceof Error && loadError.name === "AbortError")) return;
      setError(vi ? "Không thể tải cài đặt thưởng chuyên cần." : "개근 보너스 설정을 불러오지 못했습니다.");
    }
  }, [resetForm, userId, vi]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setState(null);
    setFormOpen(false);
    void load(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);

  function openForm() {
    resetForm(state?.current ?? null);
    setFormOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const response = await fetch("/api/admin/payroll/attendance-bonus/eligibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, isEligible, effectiveMonth, note }),
    });
    if (!mounted.current) return;
    setSaving(false);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      setError(
        data?.code === "ATTENDANCE_BONUS_REQUIRES_ATTENDANCE_TRACKING"
          ? vi
            ? "Thưởng chuyên cần được đánh giá bằng dữ liệu chấm công, vì vậy nhân viên phải sử dụng chấm công."
            : "개근 보너스는 근태 기록으로 판정하므로 근태 기록 사용이 필요합니다."
          : vi
            ? "Không thể lưu cài đặt thưởng chuyên cần."
            : "개근 보너스 설정을 저장하지 못했습니다.",
      );
      return;
    }
    await load();
    if (!mounted.current) return;
    setFormOpen(false);
  }

  if (!state) {
    return (
      <section style={s.card}>
        {error ? <p role="alert" style={s.error}>{error}</p> : <p style={s.empty}>{vi ? "Đang tải…" : "불러오는 중…"}</p>}
      </section>
    );
  }

  const disabledByAttendanceTracking = !state.attendanceTrackingEnabled;
  const eligible = state.current?.isEligible === true;
  const nextScheduled = state.current ? null : [...state.history]
    .filter((item) => item.effectiveMonth > state.payrollMonth)
    .sort((left, right) => left.effectiveMonth.localeCompare(right.effectiveMonth) || right.revision - left.revision)[0] ?? null;
  const statusEligibility = state.current ?? nextScheduled;
  const criteria = state.policy
    ? vi
      ? `${state.policy.minimumActualWorkdays} ngày · đi muộn ${state.policy.allowedLateCount} lần · về sớm ${state.policy.allowedEarlyLeaveCount} lần`
      : `${state.policy.minimumActualWorkdays}일 · 지각 ${state.policy.allowedLateCount}회 · 조퇴 ${state.policy.allowedEarlyLeaveCount}회`
    : vi ? "Chưa thiết lập chính sách chung" : "공통 정책 미설정";
  const monthlyStatus = attendanceBonusMonthlyStatus({
    vi,
    isEligible: statusEligibility?.isEligible === true,
    eligibilityEffectiveMonth: statusEligibility?.effectiveMonth ?? null,
    payrollMonth: state.payrollMonth,
    monthClosed: state.monthClosed,
    policy: state.policy,
    standing: state.standing,
  });

  return (
    <section style={s.card}>
      <div style={s.head}>
        <div>
          <h2 style={s.title}>{vi ? "✨ Thưởng chuyên cần" : "✨ 개근 보너스"}</h2>
          <p style={s.help}>
            {vi
              ? "Nhân viên thuộc đối tượng sẽ được tự động tính thưởng nếu đáp ứng điều kiện chấm công cuối tháng."
              : "대상 직원은 월말 근태 판정 조건을 충족하면 자동 인센티브가 계산됩니다."}
          </p>
        </div>
        <button type="button" style={s.secondary} onClick={openForm}>
          {vi ? "Thay đổi" : "설정 변경"}
        </button>
      </div>

      <div style={s.current}>
        <Summary label={vi ? "Trạng thái hiện tại" : "현재 상태"} value={eligible ? (vi ? "Áp dụng" : "대상") : vi ? "Không áp dụng" : "미대상"} />
        <Summary label={vi ? "Tháng áp dụng" : "적용월"} value={state.current?.effectiveMonth ?? "-"} />
        <Summary label={vi ? "Mức thưởng" : "보너스 금액"} value={eligible && state.policy ? formatVnd(state.policy.bonusAmount) : "-"} />
        <Summary label={vi ? "Điều kiện đánh giá" : "판정 기준"} value={criteria} />
        <Summary label={vi ? "Trạng thái tháng này" : "이번 달 상태"} value={monthlyStatus} />
      </div>

      {disabledByAttendanceTracking ? (
        <p style={s.notice}>
          {vi
            ? "Nhân viên này không sử dụng chấm công nên chưa thể chọn áp dụng thưởng chuyên cần."
            : "이 직원은 근태 기록을 사용하지 않아 개근 보너스 대상으로 설정할 수 없습니다."}
        </p>
      ) : null}

      {formOpen ? (
        <form style={s.form} onSubmit={submit}>
          <div style={s.formRow}>
            <label style={s.field}>
              {vi ? "Đối tượng thưởng chuyên cần" : "개근 보너스 대상"}
              <select
                style={s.select}
                value={isEligible ? "eligible" : "ineligible"}
                disabled={disabledByAttendanceTracking && !isEligible}
                onChange={(event) => setEligible(event.target.value === "eligible")}
              >
                <option value="ineligible">{vi ? "Không áp dụng" : "미대상"}</option>
                <option value="eligible" disabled={disabledByAttendanceTracking}>{vi ? "Áp dụng" : "대상"}</option>
              </select>
            </label>
            <label style={s.field}>
              {vi ? "Tháng áp dụng" : "적용월"}
              <input style={s.input} required type="month" min={currentMonth()} value={effectiveMonth} onChange={(event) => setEffectiveMonth(event.target.value)} />
            </label>
          </div>
          <label style={s.field}>
            {vi ? "Ghi chú (không bắt buộc)" : "메모(선택)"}
            <textarea style={s.textarea} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          {error ? <p role="alert" style={s.error}>{error}</p> : null}
          <div style={s.actions}>
            <button type="button" style={s.secondary} onClick={() => { setFormOpen(false); resetForm(state.current); }}>
              {vi ? "Hủy" : "취소"}
            </button>
            <button style={s.button} disabled={saving}>
              {saving ? (vi ? "Đang lưu…" : "저장 중…") : vi ? "Lưu" : "저장"}
            </button>
          </div>
        </form>
      ) : null}

      {!formOpen && error ? <p role="alert" style={s.error}>{error}</p> : null}

      <details style={s.details}>
        <summary>{vi ? `Lịch sử ${state.history.length} mục` : `설정 이력 ${state.history.length}건`}</summary>
        {state.history.map((item) => (
          <article style={s.history} key={item.id}>
            <b>{item.effectiveMonth} · #{item.revision}</b>
            <span>{item.isEligible ? (vi ? "Áp dụng" : "대상") : vi ? "Không áp dụng" : "미대상"}</span>
            {item.note ? <small>{item.note}</small> : null}
          </article>
        ))}
      </details>
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div style={s.summary}><span>{label}</span><b>{value}</b></div>;
}

const s = {
  card: { padding: 13, border: "1px solid #e5e7eb", borderRadius: 14, background: "#fff", display: "grid", gap: 9, minWidth: 0 },
  head: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" },
  title: { margin: 0, fontSize: 15, fontWeight: 900 },
  help: { margin: "3px 0 0", color: "#6b7280", fontSize: 12, lineHeight: 1.4 },
  current: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 6, padding: "8px 9px", borderRadius: 9, background: "#f8fafc", fontSize: 12, minWidth: 0 },
  summary: { display: "grid", gap: 3, minWidth: 0, overflowWrap: "anywhere" },
  empty: { margin: 0, padding: "10px 11px", border: "1px dashed #d1d5db", borderRadius: 10, color: "#6b7280", fontSize: 12 },
  notice: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#fffbeb", color: "#92400e", fontSize: 12, lineHeight: 1.4 },
  form: { display: "grid", gap: 8, paddingTop: 8, borderTop: "1px solid #e5e7eb" },
  formRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, minWidth: 0 },
  field: { display: "grid", gap: 5, fontSize: 13, fontWeight: 700, minWidth: 0 },
  select: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 40, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff" },
  input: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 40, padding: 8, border: "1px solid #d1d5db", borderRadius: 9 },
  textarea: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 60, padding: 8, border: "1px solid #d1d5db", borderRadius: 9, resize: "vertical" },
  actions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  button: { minHeight: 38, padding: "7px 10px", border: 0, borderRadius: 9, background: "#111827", color: "#fff", fontSize: 13, fontWeight: 800 },
  secondary: { minHeight: 36, padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#111827", fontSize: 13, fontWeight: 800 },
  error: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#fef2f2", color: "#b91c1c", fontSize: 12 },
  details: { paddingTop: 8, borderTop: "1px solid #e5e7eb", fontSize: 12 },
  history: { display: "grid", gap: 3, padding: "8px 9px", marginTop: 5, border: "1px solid #e5e7eb", borderRadius: 9, fontSize: 12, overflowWrap: "anywhere" },
} satisfies Record<string, CSSProperties>;
