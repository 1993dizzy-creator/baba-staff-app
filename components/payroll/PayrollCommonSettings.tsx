"use client";

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  calculateInsuranceAmount,
  percentToBasisPoints,
} from "@/lib/payroll/insurance";
import { formatIntegerInput, integerInputDigits } from "@/lib/payroll/contract-form";

type ApiSettings = {
  payment_day: number;
  employee_insurance_rate_bp: number;
  employer_insurance_rate_bp: number;
  director_insurance_enabled: boolean;
  director_insurance_base_amount: number;
  director_insurance_rate_bp: number;
  late_major_threshold_minutes: number;
  late_minor_penalty_minutes: number;
  late_major_penalty_rate_bp: number;
  unauthorized_absence_penalty_days: number;
};

type Draft = {
  paymentDay: string;
  employeeInsuranceRate: string;
  employerInsuranceRate: string;
  directorInsuranceEnabled: boolean;
  directorInsuranceBaseAmount: string;
  directorInsuranceRate: string;
  lateMajorThresholdMinutes: string;
  lateMinorPenaltyMinutes: string;
  lateMajorPenaltyRate: string;
  unauthorizedAbsencePenaltyDays: string;
};

function toDraft(settings: ApiSettings): Draft {
  return {
    paymentDay: String(settings.payment_day),
    employeeInsuranceRate: String(settings.employee_insurance_rate_bp / 100),
    employerInsuranceRate: String(settings.employer_insurance_rate_bp / 100),
    directorInsuranceEnabled: settings.director_insurance_enabled,
    directorInsuranceBaseAmount: String(settings.director_insurance_base_amount),
    directorInsuranceRate: String(settings.director_insurance_rate_bp / 100),
    lateMajorThresholdMinutes: String(settings.late_major_threshold_minutes),
    lateMinorPenaltyMinutes: String(settings.late_minor_penalty_minutes),
    lateMajorPenaltyRate: String(settings.late_major_penalty_rate_bp / 100),
    unauthorizedAbsencePenaltyDays: String(settings.unauthorized_absence_penalty_days),
  };
}

function toPayload(draft: Draft) {
  const paymentDay = Number(draft.paymentDay);
  const directorBase = Number(draft.directorInsuranceBaseAmount);
  const employeeRate = percentToBasisPoints(draft.employeeInsuranceRate);
  const employerRate = percentToBasisPoints(draft.employerInsuranceRate);
  const directorRate = percentToBasisPoints(draft.directorInsuranceRate);
  const lateMajorRate = percentToBasisPoints(draft.lateMajorPenaltyRate);
  const lateThreshold = Number(draft.lateMajorThresholdMinutes);
  const lateMinorMinutes = Number(draft.lateMinorPenaltyMinutes);
  const absenceDays = Number(draft.unauthorizedAbsencePenaltyDays);
  if (
    !Number.isInteger(paymentDay) ||
    paymentDay < 1 ||
    paymentDay > 28 ||
    employeeRate === null ||
    employerRate === null ||
    directorRate === null ||
    lateMajorRate === null ||
    !Number.isSafeInteger(directorBase) ||
    directorBase < 0 ||
    !Number.isInteger(lateThreshold) || lateThreshold < 1 || lateThreshold > 1440 ||
    !Number.isInteger(lateMinorMinutes) || lateMinorMinutes < 1 || lateMinorMinutes > 1440 ||
    !Number.isInteger(absenceDays) || absenceDays < 1 || absenceDays > 31
  ) return null;
  return {
    paymentDay,
    employeeInsuranceRateBp: employeeRate,
    employerInsuranceRateBp: employerRate,
    directorInsuranceEnabled: draft.directorInsuranceEnabled,
    directorInsuranceBaseAmount: directorBase,
    directorInsuranceRateBp: directorRate,
    lateMajorThresholdMinutes: lateThreshold,
    lateMinorPenaltyMinutes: lateMinorMinutes,
    lateMajorPenaltyRateBp: lateMajorRate,
    unauthorizedAbsencePenaltyDays: absenceDays,
  };
}

type MealAllowancePolicy = {
  id: number;
  dailyAmount: number;
  effectiveFrom: string;
  revision: number;
  note: string | null;
};

export default function PayrollCommonSettings({ vi }: { vi: boolean }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [snapshot, setSnapshot] = useState<Draft | null>(null);
  // 식대 공통 정책은 payroll_settings와 별개 테이블(effective-dated version)이지만, 화면과
  // 저장 버튼은 하나다 — 아래 draft/snapshot 쌍도 같은 "불러온 값 vs 편집 중인 값" 패턴을
  // 그대로 따른다. 값이 비어있으면("") "미설정" 또는 "이번 저장에서 식대는 건드리지 않음"을
  // 의미한다.
  const [mealAmountDraft, setMealAmountDraft] = useState("");
  const [mealEffectiveFromDraft, setMealEffectiveFromDraft] = useState("");
  const [mealAmountSnapshot, setMealAmountSnapshot] = useState("");
  const [mealEffectiveFromSnapshot, setMealEffectiveFromSnapshot] = useState("");
  const [mealCurrent, setMealCurrent] = useState<MealAllowancePolicy | null>(null);
  const [mealHistory, setMealHistory] = useState<MealAllowancePolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<"" | "load" | "save">("");

  const load = useCallback((signal?: AbortSignal) => {
    return Promise.all([
      fetch("/api/admin/payroll/settings", { cache: "no-store", signal }).then(async (response) => ({
        ok: response.ok,
        data: await response.json(),
      })),
      fetch("/api/admin/payroll/meal-allowance/policy", { cache: "no-store", signal }).then(async (response) => ({
        ok: response.ok,
        data: await response.json(),
      })),
    ]).then(([settingsResult, mealResult]) => {
      if (!settingsResult.ok || !settingsResult.data.settings) throw new Error("PAYROLL_SETTINGS_READ_FAILED");
      if (!mealResult.ok) throw new Error("MEAL_ALLOWANCE_POLICY_READ_FAILED");
      const next = toDraft(settingsResult.data.settings);
      setDraft(next);
      setSnapshot(next);
      const current: MealAllowancePolicy | null = mealResult.data.current ?? null;
      setMealCurrent(current);
      setMealHistory(mealResult.data.history ?? []);
      const amount = current ? String(current.dailyAmount) : "";
      const effectiveFrom = current ? current.effectiveFrom : "";
      setMealAmountDraft(amount);
      setMealEffectiveFromDraft(effectiveFrom);
      setMealAmountSnapshot(amount);
      setMealEffectiveFromSnapshot(effectiveFrom);
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .catch((caught: unknown) => {
        if ((caught as Error).name !== "AbortError") setError("load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load]);

  const errorText =
    error === "load"
      ? vi
        ? "Không thể tải cài đặt chung."
        : "공통 설정을 불러오지 못했습니다."
      : error === "save"
        ? vi
          ? "Không thể lưu cài đặt chung."
          : "공통 설정을 저장하지 못했습니다."
        : "";

  if (loading) {
    return <section style={s.card}>{vi ? "Đang tải cài đặt chung…" : "공통 설정을 불러오는 중입니다…"}</section>;
  }
  if (!draft || !snapshot) {
    return <section role="alert" style={{ ...s.card, ...s.error }}>{errorText}</section>;
  }

  const payload = toPayload(draft);
  const snapshotPayload = toPayload(snapshot);
  const settingsDirty =
    payload !== null &&
    JSON.stringify(payload) !== JSON.stringify(snapshotPayload);
  const directorRateBp = percentToBasisPoints(draft.directorInsuranceRate);
  const directorCost = calculateInsuranceAmount(
    draft.directorInsuranceEnabled
      ? Number(draft.directorInsuranceBaseAmount) || 0
      : 0,
    directorRateBp ?? 0,
  );

  // 식대: 금액·적용일은 함께 입력되거나 함께 비어 있어야 한다. 저장 시점에 최신 저장값과
  // 비교해 실제로 달라졌을 때만(RPC 쪽에서도 다시 한번) 새 revision을 만든다 — 여기서는
  // "저장 버튼을 눌러도 되는지"만 판단한다.
  const mealAmountBlank = mealAmountDraft === "";
  const mealEffectiveFromBlank = mealEffectiveFromDraft === "";
  const mealBothBlank = mealAmountBlank && mealEffectiveFromBlank;
  const mealBothFilled = !mealAmountBlank && !mealEffectiveFromBlank;
  const mealPairValid = mealBothBlank || mealBothFilled;
  const mealAmountNumber = mealBothFilled ? Number(mealAmountDraft) : null;
  const mealAmountValid = !mealBothFilled || (Number.isSafeInteger(mealAmountNumber) && mealAmountNumber! >= 0);
  const mealDateValid = !mealBothFilled || /^\d{4}-\d{2}-\d{2}$/.test(mealEffectiveFromDraft);
  const mealValid = mealPairValid && mealAmountValid && mealDateValid;
  const mealDirty = mealAmountDraft !== mealAmountSnapshot || mealEffectiveFromDraft !== mealEffectiveFromSnapshot;

  const valid = payload !== null && mealValid;
  const dirty = settingsDirty || mealDirty;

  async function save() {
    if (!draft) return;
    const nextPayload = toPayload(draft);
    if (!nextPayload || !mealValid) return;
    setSaving(true);
    setMessage("");
    setError("");
    const response = await fetch("/api/admin/payroll/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...nextPayload,
        mealDailyAmount: mealBothFilled ? mealAmountNumber : null,
        mealEffectiveFrom: mealBothFilled ? mealEffectiveFromDraft : null,
      }),
    });
    if (!response.ok) {
      // transaction 전체가 실패하면 payroll_settings도 식대 정책도 전혀 바뀌지 않는다
      // (RPC가 하나의 transaction) — 입력 draft는 그대로 유지하고 오류 메시지 하나만 표시한다.
      setSaving(false);
      setError("save");
      return;
    }
    // 성공 → 공통 설정과 식대 정책을 모두 재조회한다.
    await load();
    setSaving(false);
    setMessage(vi ? "Đã lưu cài đặt chung." : "공통 설정을 저장했습니다.");
  }

  return (
    <section style={s.card}>
      <SettingsGroup title={`💰 ${vi ? "Lương" : "급여"}`}>
        <SettingRow label={vi ? "Kỳ lương" : "급여 일정"}>
          {vi ? "Ngày 1 ~ cuối tháng" : "매월 1일 ~ 말일"}
        </SettingRow>
        <SettingRow label={vi ? "Ngày trả" : "지급일"} last>
          <span style={s.inlineValue}>
            {vi ? "Tháng sau, ngày" : "다음 달"}
            <input
              style={s.shortInput}
              aria-label={vi ? "Ngày trả lương" : "급여 지급일"}
              type="number"
              inputMode="numeric"
              min="1"
              max="28"
              value={draft.paymentDay}
              onChange={(event) =>
                setDraft({ ...draft, paymentDay: event.target.value })
              }
            />
            {vi ? "" : "일"}
          </span>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={`🛡️ ${vi ? "Bảo hiểm" : "보험"}`}>
      <SettingRow label={vi ? "Nhân viên đóng" : "직원 부담률"}>
        <PercentInput
          value={draft.employeeInsuranceRate}
          label={vi ? "NV đóng" : "직원 부담률"}
          change={(value) =>
            setDraft({ ...draft, employeeInsuranceRate: value })
          }
        />
      </SettingRow>
      <SettingRow label={vi ? "Công ty đóng" : "회사 부담률"}>
        <PercentInput
          value={draft.employerInsuranceRate}
          label={vi ? "Công ty đóng" : "회사 부담률"}
          change={(value) =>
            setDraft({ ...draft, employerInsuranceRate: value })
          }
        />
      </SettingRow>
      <SettingRow
        label={vi ? "BH giám đốc" : "법인장 보험"}
      >
        <label style={s.toggle}>
          <input
            type="checkbox"
            checked={draft.directorInsuranceEnabled}
            onChange={(event) =>
              setDraft({
                ...draft,
                directorInsuranceEnabled: event.target.checked,
              })
            }
          />
          {draft.directorInsuranceEnabled
            ? vi
              ? "Sử dụng"
              : "사용"
            : vi
              ? "Không sử dụng"
              : "미사용"}
        </label>
      </SettingRow>
      <SettingRow
        label={vi ? "Mức cơ sở" : "법인장 기준금액"}
      >
        <span style={s.percent}>
          <input
            style={s.moneyInput}
            aria-label={vi ? "Mức cơ sở" : "법인장 기준금액"}
            type="text"
            inputMode="numeric"
            disabled={!draft.directorInsuranceEnabled}
            value={formatIntegerInput(draft.directorInsuranceBaseAmount)}
            onChange={(event) =>
              setDraft({
                ...draft,
                directorInsuranceBaseAmount: integerInputDigits(event.target.value),
              })
            }
          />
          {vi ? "đồng" : "동"}
        </span>
      </SettingRow>
      <SettingRow label={vi ? "Tỷ lệ" : "법인장 부담률"}>
        <PercentInput
          value={draft.directorInsuranceRate}
          label={vi ? "Tỷ lệ" : "법인장 부담률"}
          disabled={!draft.directorInsuranceEnabled}
          change={(value) =>
            setDraft({ ...draft, directorInsuranceRate: value })
          }
        />
      </SettingRow>
      <SettingRow
        label={vi ? "Phí BH/tháng" : "월 보험비용"}
        last
      >
        <b style={s.total}>{directorCost.toLocaleString("en-US")}{vi ? " đồng" : "동"}</b>
      </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={`⚠️ ${vi ? "Phạt" : "패널티"}`}>
      <SettingRow label={vi ? "Mốc phân loại" : "지각 구간 기준"}>
        <NumberInput value={draft.lateMajorThresholdMinutes} label={vi ? "Mốc phân loại" : "지각 구간 기준"} suffix={vi ? "phút" : "분"} change={(value)=>setDraft({...draft,lateMajorThresholdMinutes:value})}/>
      </SettingRow>
      <SettingRow label={vi ? `Đi muộn 1~${draft.lateMajorThresholdMinutes || "-"} phút` : `1~${draft.lateMajorThresholdMinutes || "-"}분 지각`}>
        <NumberInput value={draft.lateMinorPenaltyMinutes} label={vi ? "Mức phạt đi muộn nhẹ" : "경미 지각 감봉 시간"} suffix={vi ? "phút lương" : "분 급여 감봉"} change={(value)=>setDraft({...draft,lateMinorPenaltyMinutes:value})}/>
      </SettingRow>
      <SettingRow label={vi ? `Đi muộn quá ${draft.lateMajorThresholdMinutes || "-"} phút` : `${draft.lateMajorThresholdMinutes || "-"}분 초과 지각`}>
        <span style={s.percent}>
          {vi ? null : "일당의"}
          <PercentInput value={draft.lateMajorPenaltyRate} label={vi ? "Tỷ lệ phạt đi muộn nặng" : "중대 지각 감봉 비율"} change={(value)=>setDraft({...draft,lateMajorPenaltyRate:value})}/>
          {vi ? "lương ngày" : null}
        </span>
      </SettingRow>
      <SettingRow label={vi ? "Nghỉ không phép" : "무단결근"} last>
        <span style={s.percent}>{vi ? null : "일당의"}<NumberInput value={draft.unauthorizedAbsencePenaltyDays} label={vi ? "Nghỉ không phép" : "무단결근"} suffix={vi ? "ngày lương" : "일분"} change={(value)=>setDraft({...draft,unauthorizedAbsencePenaltyDays:value})}/></span>
      </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={`🍚 ${vi ? "Trợ cấp ăn" : "식대"}`}>
        <SettingRow label={vi ? "Hiện đang áp dụng" : "현재 적용 중"}>
          <span style={s.inlineValue}>
            {mealCurrent
              ? `${mealCurrent.dailyAmount.toLocaleString("en-US")}${vi ? " đồng" : "동"} · ${mealCurrent.effectiveFrom}`
              : vi
                ? "Chưa thiết lập"
                : "미설정"}
          </span>
        </SettingRow>
        <SettingRow label={vi ? "Trợ cấp ăn mỗi ngày" : "1일 기본 식대"}>
          <span style={s.percent}>
            <input
              style={s.moneyInput}
              aria-label={vi ? "Trợ cấp ăn mỗi ngày" : "1일 기본 식대"}
              type="text"
              inputMode="numeric"
              value={formatIntegerInput(mealAmountDraft)}
              onChange={(event) => setMealAmountDraft(integerInputDigits(event.target.value))}
            />
            {vi ? "đồng" : "동"}
          </span>
        </SettingRow>
        <SettingRow label={vi ? "Ngày áp dụng" : "적용일"} last>
          <input
            style={s.dateInput}
            aria-label={vi ? "Ngày áp dụng trợ cấp ăn" : "식대 적용일"}
            type="date"
            value={mealEffectiveFromDraft}
            onChange={(event) => setMealEffectiveFromDraft(event.target.value)}
          />
        </SettingRow>
        {!mealPairValid ? (
          <p role="alert" style={s.error}>
            {vi
              ? "Vui lòng nhập cả số tiền và ngày áp dụng, hoặc để trống cả hai."
              : "금액과 적용일을 함께 입력하거나, 둘 다 비워두세요."}
          </p>
        ) : null}
        <details style={s.details}>
          <summary>{vi ? `Lịch sử ${mealHistory.length} mục` : `식대 설정 이력 ${mealHistory.length}건`}</summary>
          {mealHistory.map((item) => (
            <article key={item.id} style={s.mealHistory}>
              <b>{item.effectiveFrom} · #{item.revision}</b>
              <span>{item.dailyAmount.toLocaleString("en-US")}{vi ? " đồng" : "동"}</span>
            </article>
          ))}
        </details>
      </SettingsGroup>

      {error ? <p role="alert" style={s.error}>{errorText}</p> : null}
      {message ? <p role="status" style={s.success}>{message}</p> : null}
      <button
        type="button"
        style={s.button}
        disabled={!dirty || !valid || saving}
        onClick={save}
      >
        {saving
          ? vi
            ? "Đang lưu…"
            : "저장 중…"
          : vi
            ? "Lưu cài đặt chung"
            : "공통 설정 저장"}
      </button>
    </section>
  );
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section style={s.group}><h2 style={s.sectionTitle}>{title}</h2><div>{children}</div></section>;
}

function SettingRow({ label, children, last = false }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div style={last ? { ...s.row, borderBottom: 0 } : s.row}>
      <span style={s.label}>{label}</span>
      <div style={s.value}>{children}</div>
    </div>
  );
}

function PercentInput({
  value,
  label,
  disabled = false,
  change,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  change: (value: string) => void;
}) {
  return (
    <span style={s.percent}>
      <input
        style={s.shortInput}
        aria-label={label}
        type="number"
        inputMode="decimal"
        min="0"
        max="100"
        step="0.01"
        disabled={disabled}
        value={value}
        onChange={(event) => change(event.target.value)}
      />
      %
    </span>
  );
}

function NumberInput({value,label,suffix,change}:{value:string;label:string;suffix:string;change:(value:string)=>void}) {
  return <span style={s.percent}><input style={s.shortInput} aria-label={label} type="number" inputMode="numeric" min="1" step="1" value={value} onChange={(event)=>change(event.target.value)}/>{suffix}</span>;
}

const s = {
  card: {
    padding: 14,
    border: "1px solid #e5e7eb",
    borderRadius: 14,
    background: "#fff",
    display: "grid",
    gap: 10,
    minWidth: 0,
    fontSize: 13,
  },
  group: { padding: "10px 11px", border: "1px solid #e5e7eb", borderRadius: 11, background: "#f8fafc", minWidth: 0 },
  sectionTitle: { margin: "0 0 5px", fontSize: 15, fontWeight: 900 },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(104px, auto) minmax(0, 1fr)",
    alignItems: "center",
    gap: 8,
    minHeight: 40,
    borderBottom: "1px solid #f1f5f9",
    minWidth: 0,
  },
  label: { color: "#374151", fontWeight: 800, fontSize: 12, whiteSpace: "nowrap" },
  value: { display: "flex", justifyContent: "flex-end", alignItems: "center", minWidth: 0, textAlign: "right", overflowWrap: "anywhere" },
  inlineValue: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4, minWidth: 0, whiteSpace: "nowrap", fontSize: 12 },
  moneyInput: { boxSizing: "border-box", width: 112, maxWidth: "100%", height: 34, padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", fontSize: 13, textAlign: "right" },
  shortInput: { boxSizing: "border-box", width: 56, maxWidth: "100%", height: 34, padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", fontSize: 13, textAlign: "right" },
  dateInput: { boxSizing: "border-box", width: "100%", minWidth: 0, maxWidth: 160, height: 34, padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", fontSize: 13 },
  percent: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, whiteSpace: "nowrap", minWidth: 0, fontSize: 12 },
  toggle: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7, minHeight: 40, fontWeight: 800 },
  total: { fontSize: 15, fontWeight: 900 },
  button: { minHeight: 44, marginTop: 14, padding: "10px 14px", border: 0, borderRadius: 10, background: "#111827", color: "#fff", fontWeight: 900 },
  error: { margin: "10px 0 0", padding: 9, borderRadius: 9, background: "#fef2f2", color: "#b91c1c" },
  success: { margin: "10px 0 0", padding: 9, borderRadius: 9, background: "#f0fdf4", color: "#166534" },
  details: { marginTop: 8, paddingTop: 8, borderTop: "1px solid #f1f5f9", fontSize: 12 },
  mealHistory: { display: "grid", gap: 2, padding: "6px 8px", marginTop: 4, borderRadius: 8, background: "#f9fafb", fontSize: 12 },
} satisfies Record<string, CSSProperties>;
