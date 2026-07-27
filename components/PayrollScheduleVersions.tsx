"use client";

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";

type Schedule = { id:number; startTime:string; endTime:string; unpaidBreakMinutes:number; effectiveFrom:string; effectiveTo:string|null; revision:number; changeReason:string|null };

export default function PayrollScheduleVersions({ userId, vi }: { userId:number; vi:boolean }) {
  const [history, setHistory] = useState<Schedule[]>([]);
  const [allowedDate, setAllowedDate] = useState("");
  const [changesAllowed, setChangesAllowed] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ startTime:"16:00", endTime:"01:00", unpaidBreakMinutes:"0", changeReason:"" });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/payroll/schedules?userId=${userId}`, { cache:"no-store", signal:controller.signal })
      .then((response) => response.json())
      .then((data) => {
        if (!data.ok) return;
        setHistory(data.history);
        setAllowedDate(data.allowedEffectiveDate);
        setChangesAllowed(data.scheduleChangesAllowed === true);
        const template = data.current ?? data.scheduled;
        if (template) setForm((value) => ({ ...value, startTime:template.startTime, endTime:template.endTime, unpaidBreakMinutes:String(template.unpaidBreakMinutes) }));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [userId]);

  async function submit(event:FormEvent) {
    event.preventDefault();
    if (!changesAllowed) return;
    setMessage("");
    const response = await fetch("/api/admin/payroll/schedules", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ userId, effectiveFrom:allowedDate, startTime:form.startTime, endTime:form.endTime, unpaidBreakMinutes:Number(form.unpaidBreakMinutes), changeReason:form.changeReason }) });
    const data = await response.json();
    if (!response.ok) { setMessage(vi ? "Không thể lưu phiên bản giờ làm." : "근무시간 버전을 저장할 수 없습니다."); return; }
    setHistory((previous) => [data.schedule, ...previous.map((item) => item.effectiveTo === null && item.effectiveFrom < data.schedule.effectiveFrom ? { ...item, effectiveTo:data.schedule.effectiveFrom } : item)]);
    setMessage(vi ? "Đã tạo phiên bản giờ làm mới." : "새 근무시간 버전을 생성했습니다.");
  }

  const current = history.find((item) => item.effectiveFrom <= allowedDate && (!item.effectiveTo || item.effectiveTo > allowedDate));
  const scheduled = history.find((item) => item.effectiveFrom > allowedDate);

  return <section style={styles.section}>
    <h2>{vi ? "Phiên bản giờ làm" : "근무시간 version"}</h2>
    <p style={styles.current}><b>{vi ? "Hiện tại" : "현재"}:</b> {current ? `${current.startTime}–${current.endTime} · ${current.unpaidBreakMinutes} min break · #${current.revision}` : "-"}</p>
    <p style={styles.current}><b>{vi ? "Sắp áp dụng" : "적용 예정"}:</b> {scheduled ? `${scheduled.effectiveFrom} · ${scheduled.startTime}–${scheduled.endTime} · ${scheduled.unpaidBreakMinutes} min break · #${scheduled.revision}` : "-"}</p>
    <form onSubmit={submit} style={styles.form}>
      <label>{vi ? "Ngày áp dụng" : "적용 시작일"}<input type="date" value={allowedDate} readOnly /></label>
      <label>{vi ? "Giờ vào" : "출근시간"}<input type="time" required value={form.startTime} onChange={(event) => setForm({ ...form, startTime:event.target.value })} /></label>
      <label>{vi ? "Giờ ra" : "퇴근시간"}<input type="time" required value={form.endTime} onChange={(event) => setForm({ ...form, endTime:event.target.value })} /></label>
      <label>{vi ? "Nghỉ không lương (phút)" : "무급 휴게시간(분)"}<input type="number" min="0" max="720" required value={form.unpaidBreakMinutes} onChange={(event) => setForm({ ...form, unpaidBreakMinutes:event.target.value })} /></label>
      <label>{vi ? "Lý do thay đổi" : "변경 사유"}<input required value={form.changeReason} onChange={(event) => setForm({ ...form, changeReason:event.target.value })} /></label>
      <button disabled={!changesAllowed}>{vi ? "Tạo phiên bản giờ làm" : "근무시간 버전 생성"}</button>
    </form>
    <small>{!changesAllowed ? (vi ? "Có thể thay đổi từ ngày 01/08/2026." : "2026-08-01부터 변경할 수 있습니다.") : (vi ? "Không hỗ trợ đặt lịch cho ngày tương lai." : "미래 적용 스케줄은 지원하지 않습니다.")}</small>
    {message && <p>{message}</p>}
    <h3>{vi ? "Lịch sử giờ làm" : "근무시간 이력"}</h3>
    {history.map((item) => <div key={item.id} style={styles.row}>#{item.revision} · {item.effectiveFrom} ≤ date &lt; {item.effectiveTo || "∞"} · {item.startTime}–{item.endTime} · break {item.unpaidBreakMinutes}m · {item.changeReason || "-"}</div>)}
  </section>;
}

const styles = { section:{ marginTop:18, paddingTop:16, borderTop:"1px solid #e5e7eb" }, current:{ padding:12, background:"#f9fafb", borderRadius:10, fontWeight:800 }, form:{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10 }, row:{ padding:9, marginTop:6, background:"#f9fafb", borderRadius:8, fontSize:12 } } satisfies Record<string,CSSProperties>;
