"use client";

import { useEffect, useState, type CSSProperties } from "react";
import {
  calculateInsuranceAmount,
  percentToBasisPoints,
} from "@/lib/payroll/insurance";
import { money } from "@/lib/payroll/ui-labels";

type Settings = {
  payment_day: number;
  employee_insurance_rate_bp: number;
  employer_insurance_rate_bp: number;
  director_insurance_enabled: boolean;
  director_insurance_base_amount: number;
  director_insurance_rate_bp: number;
};

export default function PayrollInsuranceSettings({ vi }: { vi: boolean }) {
  const [data, setData] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/payroll/settings", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((result) => setData(result.settings ?? null))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (!data) return <section style={s.card}><p style={s.help}>{vi ? "Đang tải tiêu chuẩn bảo hiểm…" : "보험 기준을 불러오는 중입니다…"}</p></section>;

  const settings = data;
  const director = calculateInsuranceAmount(
    data.director_insurance_enabled ? data.director_insurance_base_amount : 0,
    data.director_insurance_rate_bp,
  );

  async function save() {
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/admin/payroll/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentDay: settings.payment_day,
        employeeInsuranceRateBp: settings.employee_insurance_rate_bp,
        employerInsuranceRateBp: settings.employer_insurance_rate_bp,
        directorInsuranceEnabled: settings.director_insurance_enabled,
        directorInsuranceBaseAmount: settings.director_insurance_base_amount,
        directorInsuranceRateBp: settings.director_insurance_rate_bp,
      }),
    });
    setSaving(false);
    setMessage(
      response.ok
        ? vi
          ? "Đã lưu cài đặt bảo hiểm."
          : "보험 설정을 저장했습니다."
        : vi
          ? "Không thể lưu cài đặt bảo hiểm."
          : "보험 설정을 저장하지 못했습니다.",
    );
  }

  return (
    <section style={s.card}>
      <div>
        <h2 style={s.title}>{vi ? "Tiêu chuẩn bảo hiểm" : "보험 기준"}</h2>
        <p style={s.help}>
          {vi
            ? "Khoản nhân viên đóng và công ty đóng được tính theo mức lương cơ sở bảo hiểm của từng nhân viên."
            : "직원 공제와 회사 부담은 직원별 보험 기준급여에 적용됩니다."}
        </p>
      </div>
      <div style={s.rateGrid}>
        <Rate label={vi ? "Tỷ lệ nhân viên" : "직원 부담률"} value={data.employee_insurance_rate_bp} change={(value) => setData({ ...data, employee_insurance_rate_bp: value })} />
        <Rate label={vi ? "Tỷ lệ công ty" : "회사 부담률"} value={data.employer_insurance_rate_bp} change={(value) => setData({ ...data, employer_insurance_rate_bp: value })} />
      </div>
      <div style={s.director}>
        <label style={s.toggleRow}>
          <span>{vi ? "Áp dụng bảo hiểm giám đốc pháp nhân" : "법인장 보험 사용"}</span>
          <input type="checkbox" checked={data.director_insurance_enabled} onChange={(event) => setData({ ...data, director_insurance_enabled: event.target.checked })} />
        </label>
        <p style={s.help}>
          {vi
            ? "Bảo hiểm giám đốc pháp nhân là chi phí công ty, tách khỏi lương nhân viên."
            : "법인장 보험은 직원 급여와 분리된 회사 비용입니다."}
        </p>
        <NumberField label={vi ? "Mức cơ sở bảo hiểm giám đốc" : "법인장 보험 기준금액"} value={data.director_insurance_base_amount} change={(value) => setData({ ...data, director_insurance_base_amount: value })} />
        <Rate label={vi ? "Tỷ lệ bảo hiểm giám đốc" : "법인장 보험 부담률"} value={data.director_insurance_rate_bp} change={(value) => setData({ ...data, director_insurance_rate_bp: value })} />
        <div style={s.total}>
          <span>{vi ? "Chi phí bảo hiểm giám đốc hàng tháng" : "법인장 월 보험비용"}</span>
          <b>{money(director)}</b>
        </div>
      </div>
      <button type="button" style={s.button} disabled={saving} onClick={save}>
        {saving ? (vi ? "Đang lưu…" : "저장 중…") : vi ? "Lưu bảo hiểm" : "보험 설정 저장"}
      </button>
      {message ? <p role="status" style={s.message}>{message}</p> : null}
    </section>
  );
}

function Rate({ label, value, change }: { label: string; value: number; change: (value: number) => void }) {
  return (
    <label style={s.field}>
      <span>{label}</span>
      <span style={s.percent}>
        <input style={s.input} type="number" min="0" max="100" step="0.01" value={value / 100} onChange={(event) => { const bp = percentToBasisPoints(event.target.value); if (bp !== null) change(bp); }} /> %
      </span>
    </label>
  );
}

function NumberField({ label, value, change }: { label: string; value: number; change: (value: number) => void }) {
  return <label style={s.field}><span>{label}</span><input style={s.input} type="number" min="0" step="1" value={value} onChange={(event) => change(Number(event.target.value))} /></label>;
}

const s = {
  card: { padding: 14, border: "1px solid #e5e7eb", borderRadius: 14, background: "#fff", display: "grid", gap: 10, alignContent: "start", minWidth: 0 },
  title: { margin: 0, fontSize: 17, fontWeight: 900 },
  help: { margin: "4px 0 0", color: "#6b7280", fontSize: 13, lineHeight: 1.45 },
  rateGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 },
  director: { display: "grid", gap: 9, padding: 11, border: "1px solid #e5e7eb", borderRadius: 11, background: "#f9fafb" },
  toggleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, minHeight: 40, fontSize: 13, fontWeight: 800 },
  field: { display: "grid", gap: 5, minWidth: 0, fontSize: 13, fontWeight: 700 },
  percent: { display: "flex", alignItems: "center", gap: 6 },
  input: { width: "100%", minWidth: 0, minHeight: 42, padding: 8, border: "1px solid #d1d5db", borderRadius: 9, background: "#fff" },
  total: { display: "flex", justifyContent: "space-between", gap: 10, padding: 12, borderRadius: 10, background: "#eff6ff", flexWrap: "wrap", fontSize: 13 },
  button: { minHeight: 42, padding: "9px 13px", border: 0, borderRadius: 10, background: "#111827", color: "#fff", fontWeight: 800 },
  message: { margin: 0, padding: 9, borderRadius: 9, background: "#f0fdf4", fontSize: 13 },
} satisfies Record<string, CSSProperties>;
