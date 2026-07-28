"use client";

import { useEffect, useState } from "react";

export default function PayrollScheduleSettings({ vi }: { vi: boolean }) {
  const [day,setDay]=useState(10); const [saving,setSaving]=useState(false); const [message,setMessage]=useState("");
  useEffect(()=>{const controller=new AbortController();fetch("/api/admin/payroll/settings",{cache:"no-store",signal:controller.signal}).then(async response=>({ok:response.ok,data:await response.json()})).then(({ok,data})=>{if(ok&&data.settings)setDay(Number(data.settings.payment_day))}).catch(()=>undefined);return()=>controller.abort()},[]);
  async function save(){setSaving(true);setMessage("");const response=await fetch("/api/admin/payroll/settings",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({paymentDay:day})});setSaving(false);setMessage(response.ok?(vi?"Đã lưu lịch trả lương.":"급여 일정을 저장했습니다."):(vi?"Không thể lưu lịch trả lương.":"급여 일정을 저장하지 못했습니다."));}
  return <section style={{padding:16,border:"1px solid #e5e7eb",borderRadius:16,background:"#fff",display:"grid",gap:10}}>
    <h2 style={{margin:0,fontSize:18}}>{vi?"Lịch trả lương":"급여 일정"}</h2>
    <div><b>{vi?"Kỳ tính lương":"정산 기간"}</b><p style={{margin:"4px 0",fontSize:13,color:"#6b7280"}}>{vi?"Từ ngày 1 đến ngày cuối tháng":"매월 1일 ~ 말일"}</p></div>
    <label style={{display:"grid",gap:6,fontSize:13,fontWeight:800}}>{vi?"Ngày trả lương":"지급일"}<span style={{display:"flex",alignItems:"center",gap:8}}>{vi?"Ngày":"다음 달"}<input aria-label={vi?"Ngày trả lương":"급여 지급일"} type="number" min={1} max={28} value={day} onChange={event=>setDay(Number(event.target.value))} style={{width:72,minHeight:40,padding:8,border:"1px solid #d1d5db",borderRadius:10}}/>{vi?"của tháng tiếp theo":"일"}</span></label>
    <button type="button" disabled={saving||day<1||day>28} onClick={save} style={{minHeight:42,border:0,borderRadius:10,background:"#111827",color:"#fff",fontWeight:800}}>{saving?(vi?"Đang lưu…":"저장 중…"):(vi?"Lưu lịch":"일정 저장")}</button>
    {message?<p role="status" style={{margin:0,fontSize:13}}>{message}</p>:null}
  </section>;
}
