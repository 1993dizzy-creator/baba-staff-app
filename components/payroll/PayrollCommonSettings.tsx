"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
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

export default function PayrollCommonSettings({ vi }: { vi: boolean }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [snapshot, setSnapshot] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<"" | "load" | "save">("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/payroll/settings", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => ({
        ok: response.ok,
        data: await response.json(),
      }))
      .then(({ ok, data }) => {
        if (!ok || !data.settings) throw new Error("PAYROLL_SETTINGS_READ_FAILED");
        const next = toDraft(data.settings);
        setDraft(next);
        setSnapshot(next);
      })
      .catch((caught: unknown) => {
        if ((caught as Error).name !== "AbortError") {
          setError("load");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

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
  const dirty =
    payload !== null &&
    JSON.stringify(payload) !== JSON.stringify(snapshotPayload);
  const valid = payload !== null;
  const directorRateBp = percentToBasisPoints(draft.directorInsuranceRate);
  const directorCost = calculateInsuranceAmount(
    draft.directorInsuranceEnabled
      ? Number(draft.directorInsuranceBaseAmount) || 0
      : 0,
    directorRateBp ?? 0,
  );

  async function save() {
    if (!draft) return;
    const nextPayload = toPayload(draft);
    if (!nextPayload) return;
    setSaving(true);
    setMessage("");
    setError("");
    const response = await fetch("/api/admin/payroll/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextPayload),
    });
    const data = await response.json().catch(() => null);
    setSaving(false);
    if (!response.ok || !data?.settings) {
      setError("save");
      return;
    }
    const next = toDraft(data.settings);
    setDraft(next);
    setSnapshot(next);
    setMessage(
      vi ? "Đã lưu cài đặt chung." : "공통 설정을 저장했습니다.",
    );
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
  percent: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, whiteSpace: "nowrap", minWidth: 0, fontSize: 12 },
  toggle: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 7, minHeight: 40, fontWeight: 800 },
  total: { fontSize: 15, fontWeight: 900 },
  button: { minHeight: 44, marginTop: 14, padding: "10px 14px", border: 0, borderRadius: 10, background: "#111827", color: "#fff", fontWeight: 900 },
  error: { margin: "10px 0 0", padding: 9, borderRadius: 9, background: "#fef2f2", color: "#b91c1c" },
  success: { margin: "10px 0 0", padding: 9, borderRadius: 9, background: "#f0fdf4", color: "#166534" },
} satisfies Record<string, CSSProperties>;
