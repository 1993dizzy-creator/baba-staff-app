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
import { money } from "@/lib/payroll/ui-labels";

type MealAllowanceVersion = {
  id: number;
  userId: number;
  isEligible: boolean;
  effectiveFrom: string;
  revision: number;
  note: string | null;
};

type MealAllowanceState = {
  current: MealAllowanceVersion | null;
  history: MealAllowanceVersion[];
  attendanceTrackingEnabled: boolean;
  standardWorkdays: number | null;
  dailyAmount: number | null;
  projectedMealAllowance: { amount: number; warningCode: "STANDARD_WORKDAYS_MISSING" | null };
};

function vietnamToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export default function EmployeeMealAllowanceSettings({
  userId,
  vi,
}: {
  userId: number;
  vi: boolean;
}) {
  const mounted = useRef(true);
  const [state, setState] = useState<MealAllowanceState | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [isEligible, setIsEligible] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(vietnamToday);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [blockedCode, setBlockedCode] = useState("");

  const resetForm = useCallback((current: MealAllowanceVersion | null) => {
    setIsEligible(current?.isEligible ?? false);
    setEffectiveFrom(vietnamToday());
    setNote("");
    setError("");
    setBlockedCode("");
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(`/api/admin/payroll/meal-allowance/eligibility?userId=${userId}`, {
          cache: "no-store",
          signal,
        });
        if (signal?.aborted || !mounted.current) return;
        const data = await response.json();
        if (signal?.aborted || !mounted.current) return;
        if (!response.ok) {
          setError(vi ? "Không thể tải cài đặt trợ cấp ăn." : "식대 대상 설정을 불러오지 못했습니다.");
          return;
        }
        const next: MealAllowanceState = {
          current: data.current ?? null,
          history: data.history ?? [],
          attendanceTrackingEnabled: data.attendanceTrackingEnabled !== false,
          standardWorkdays: data.standardWorkdays ?? null,
          dailyAmount: data.dailyAmount ?? null,
          projectedMealAllowance: data.projectedMealAllowance ?? { amount: 0, warningCode: null },
        };
        setState(next);
        resetForm(next.current);
      } catch (loadError: unknown) {
        if (signal?.aborted || !mounted.current || (loadError instanceof Error && loadError.name === "AbortError")) return;
        setError(vi ? "Không thể tải cài đặt trợ cấp ăn." : "식대 대상 설정을 불러오지 못했습니다.");
      }
    },
    [resetForm, userId, vi],
  );

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
    setBlockedCode("");
    const response = await fetch("/api/admin/payroll/meal-allowance/eligibility", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, isEligible, effectiveFrom, note }),
    });
    if (!mounted.current) return;
    setSaving(false);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      if (data?.code === "MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING") {
        setBlockedCode(data.code);
      } else {
        setError(vi ? "Không thể lưu cài đặt trợ cấp ăn." : "식대 대상 설정을 저장하지 못했습니다.");
      }
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

  return (
    <section style={s.card}>
      <div style={s.head}>
        <div>
          <h2 style={s.title}>{vi ? "Trợ cấp ăn" : "🍚 식대"}</h2>
          <p style={s.help}>
            {vi
              ? "Nhân viên thuộc đối tượng nhận trợ cấp ăn sẽ được tính chi phí ăn theo ngày đi làm thực tế."
              : "식대 대상 직원은 실제 출근일을 기준으로 식대비용이 계산됩니다."}
          </p>
        </div>
        <button type="button" style={s.secondary} onClick={openForm}>
          {vi ? "Thay đổi" : "설정 변경"}
        </button>
      </div>

      <div style={s.current}>
        <Summary
          label={vi ? "Trạng thái hiện tại" : "현재 상태"}
          value={state.current?.isEligible ? (vi ? "Áp dụng" : "대상") : vi ? "Không áp dụng" : "미대상"}
        />
        <Summary label={vi ? "Ngày áp dụng" : "적용일"} value={state.current?.effectiveFrom ?? "-"} />
        <Summary
          label={vi ? "Số ngày làm việc tiêu chuẩn/tháng" : "한 달 기준 근무일수"}
          value={state.standardWorkdays !== null ? (vi ? `${state.standardWorkdays} ngày` : `${state.standardWorkdays}일`) : "-"}
        />
        <Summary
          label={vi ? "Chi phí ăn dự kiến" : "예상 식대"}
          value={
            state.current?.isEligible
              ? state.projectedMealAllowance.warningCode === "STANDARD_WORKDAYS_MISSING"
                ? vi
                  ? "Cần thiết lập số ngày làm việc trong tháng"
                  : "월 근무일수 설정 필요"
                : state.dailyAmount === null
                  ? vi
                    ? "Chưa thiết lập trợ cấp ăn mỗi ngày"
                    : "1일 기본 식대 미설정"
                  : money(state.projectedMealAllowance.amount)
              : vi
                ? "Không áp dụng"
                : "미대상"
          }
        />
      </div>

      {disabledByAttendanceTracking ? (
        <p style={s.notice}>
          {vi
            ? "Nhân viên này không sử dụng chấm công nên chưa thể chọn thuộc đối tượng nhận trợ cấp ăn."
            : "이 직원은 근태 기록을 사용하지 않아 식대 대상으로 설정할 수 없습니다."}
        </p>
      ) : null}

      {formOpen ? (
        <form style={s.form} onSubmit={submit}>
          <label style={s.toggleRow}>
            <span>{vi ? "Đối tượng được trợ cấp ăn" : "식대 대상"}</span>
            <select
              style={s.select}
              value={isEligible ? "eligible" : "ineligible"}
              disabled={disabledByAttendanceTracking && !isEligible}
              onChange={(event) => setIsEligible(event.target.value === "eligible")}
            >
              <option value="ineligible">{vi ? "Không áp dụng" : "미대상"}</option>
              <option value="eligible" disabled={disabledByAttendanceTracking}>
                {vi ? "Áp dụng" : "대상"}
              </option>
            </select>
          </label>
          {blockedCode === "MEAL_ALLOWANCE_REQUIRES_ATTENDANCE_TRACKING" ? (
            <p role="alert" style={s.error}>
              {vi
                ? "Chi phí ăn được tính theo dữ liệu chấm công thực tế, vì vậy nhân viên phải sử dụng chấm công."
                : "식대비용은 실제 출근 기록을 기준으로 계산하므로 근태 기록 사용이 필요합니다."}
            </p>
          ) : null}
          <label style={s.field}>
            {vi ? "Ngày áp dụng" : "적용일"}
            <input
              style={s.input}
              required
              type="date"
              value={effectiveFrom}
              onChange={(event) => setEffectiveFrom(event.target.value)}
            />
          </label>
          <label style={s.field}>
            {vi ? "Ghi chú (không bắt buộc)" : "메모(선택)"}
            <textarea style={s.textarea} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          {error ? <p role="alert" style={s.error}>{error}</p> : null}
          <div style={s.actions}>
            <button
              type="button"
              style={s.secondary}
              onClick={() => {
                setFormOpen(false);
                resetForm(state.current);
              }}
            >
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
            <b>{item.effectiveFrom} · #{item.revision}</b>
            <span>{item.isEligible ? (vi ? "Áp dụng" : "대상") : vi ? "Không áp dụng" : "미대상"}</span>
            {item.note ? <small>{item.note}</small> : null}
          </article>
        ))}
      </details>
    </section>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div style={s.summary}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
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
  field: { display: "grid", gap: 5, fontSize: 13, fontWeight: 700, minWidth: 0 },
  toggleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, minHeight: 44, padding: "8px 10px", borderRadius: 10, background: "#f9fafb", fontSize: 13, fontWeight: 800, minWidth: 0 },
  select: { minWidth: 0, minHeight: 38, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff" },
  input: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 40, padding: 8, border: "1px solid #d1d5db", borderRadius: 9 },
  textarea: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 60, padding: 8, border: "1px solid #d1d5db", borderRadius: 9, resize: "vertical" },
  actions: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  button: { minHeight: 38, padding: "7px 10px", border: 0, borderRadius: 9, background: "#111827", color: "#fff", fontSize: 13, fontWeight: 800 },
  secondary: { minHeight: 36, padding: "7px 10px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#111827", fontSize: 13, fontWeight: 800 },
  error: { margin: 0, padding: "8px 9px", borderRadius: 9, background: "#fef2f2", color: "#b91c1c", fontSize: 12 },
  details: { paddingTop: 8, borderTop: "1px solid #e5e7eb", fontSize: 12 },
  history: { display: "grid", gap: 3, padding: "8px 9px", marginTop: 5, border: "1px solid #e5e7eb", borderRadius: 9, fontSize: 12, overflowWrap: "anywhere" },
} satisfies Record<string, CSSProperties>;
