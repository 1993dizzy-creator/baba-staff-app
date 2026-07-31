"use client";

import { useEffect, useState, type CSSProperties } from "react";

export default function PayrollScheduleSettings({ vi }: { vi: boolean }) {
  const [day, setDay] = useState(10);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/payroll/settings", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => ({ ok: response.ok, data: await response.json() }))
      .then(({ ok, data }) => {
        if (ok && data.settings) setDay(Number(data.settings.payment_day));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function save() {
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/admin/payroll/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentDay: day }),
    });
    setSaving(false);
    setMessage(
      response.ok
        ? vi
          ? "Đã lưu lịch trả lương."
          : "급여 일정을 저장했습니다."
        : vi
          ? "Không thể lưu lịch trả lương."
          : "급여 일정을 저장하지 못했습니다.",
    );
  }

  return (
    <section style={s.card}>
      <h2 style={s.title}>{vi ? "Lịch trả lương" : "급여 일정"}</h2>
      <div style={s.summary}>
        <span>{vi ? "Kỳ tính lương" : "정산 기간"}</span>
        <b>{vi ? "Từ ngày 1 đến ngày cuối tháng" : "매월 1일 ~ 말일"}</b>
      </div>
      <label style={s.field}>
        {vi ? "Ngày trả lương" : "지급일"}
        <span style={s.dayRow}>
          {vi ? "Ngày" : "다음 달"}
          <input
            aria-label={vi ? "Ngày trả lương" : "급여 지급일"}
            type="number"
            min={1}
            max={28}
            value={day}
            onChange={(event) => setDay(Number(event.target.value))}
            style={s.input}
          />
          {vi ? "của tháng tiếp theo" : "일"}
        </span>
      </label>
      <button
        type="button"
        disabled={saving || day < 1 || day > 28}
        onClick={save}
        style={s.button}
      >
        {saving ? (vi ? "Đang lưu…" : "저장 중…") : vi ? "Lưu lịch" : "일정 저장"}
      </button>
      {message ? <p role="status" style={s.message}>{message}</p> : null}
    </section>
  );
}

const s = {
  card: { padding: 14, border: "1px solid #e5e7eb", borderRadius: 14, background: "#fff", display: "grid", gap: 10, alignContent: "start", minWidth: 0 },
  title: { margin: 0, fontSize: 17, fontWeight: 900 },
  summary: { display: "flex", justifyContent: "space-between", gap: 10, padding: 10, borderRadius: 10, background: "#f9fafb", fontSize: 13, flexWrap: "wrap" },
  field: { display: "grid", gap: 6, fontSize: 13, fontWeight: 800 },
  dayRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontWeight: 600 },
  input: { width: 76, minHeight: 42, padding: 8, border: "1px solid #d1d5db", borderRadius: 10 },
  button: { minHeight: 42, padding: "9px 13px", border: 0, borderRadius: 10, background: "#111827", color: "#fff", fontWeight: 800 },
  message: { margin: 0, padding: 9, borderRadius: 9, background: "#f0fdf4", fontSize: 13 },
} satisfies Record<string, CSSProperties>;
