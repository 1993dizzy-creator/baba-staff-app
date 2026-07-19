"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/lib/language-context";
import type { PosShadowResult } from "@/lib/store-settings/pos-shadow-core";

const copy = {
  ko: {
    title: "POS 연동 비교", readOnly: "읽기 전용 검사",
    description: "실제 매출이나 재고를 변경하지 않고 기존 시간 기준과 새 매장설정 기준을 비교합니다.",
    date: "영업일", run: "비교 실행", running: "검사 중",
    setting: "설정 기준", range: "조회 범위", receipts: "영수증 분류", missing: "누락",
    match: "일치", mismatch: "불일치", ready: "전환 준비 완료", incomplete: "추가 확인 필요",
    error: "CUKCUK 조회 실패", forbidden: "권한 없음", limit: "조회 한도 도달",
    details: "기술 상세", fallback: "Fallback 사용", revision: "설정 Revision",
  },
  vi: {
    title: "So sánh kết nối POS", readOnly: "Kiểm tra chỉ đọc",
    description: "So sánh tiêu chuẩn thời gian cũ và cài đặt cửa hàng mới mà không thay đổi doanh thu hoặc tồn kho.",
    date: "Ngày kinh doanh", run: "Chạy so sánh", running: "Đang kiểm tra",
    setting: "Cài đặt", range: "Phạm vi truy vấn", receipts: "Phân loại hóa đơn", missing: "Thiếu",
    match: "Khớp", mismatch: "Không khớp", ready: "Sẵn sàng chuyển đổi", incomplete: "Cần kiểm tra thêm",
    error: "Không thể truy vấn CUKCUK", forbidden: "Không có quyền", limit: "Đã đạt giới hạn truy vấn",
    details: "Chi tiết kỹ thuật", fallback: "Dùng cài đặt dự phòng", revision: "Revision cài đặt",
  },
} as const;

type ApiResponse = { ok: true; result: PosShadowResult } | { ok: false; code?: string };

type GateResponse = {
  ok: true;
  overview: { businessDate: string };
  capabilities: { posShadow: boolean };
};

export function StorePosShadowGate() {
  const [businessDate, setBusinessDate] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/store-settings", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<GateResponse> : null)
      .then((payload) => {
        if (payload?.ok && payload.capabilities.posShadow) setBusinessDate(payload.overview.businessDate);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("Failed to load POS shadow capability");
        }
      });
    return () => controller.abort();
  }, []);
  return businessDate ? <StorePosShadowPanel defaultBusinessDate={businessDate}/> : null;
}

export default function StorePosShadowPanel({ defaultBusinessDate }: { defaultBusinessDate: string }) {
  const { lang } = useLanguage();
  const t = copy[lang];
  const [businessDate, setBusinessDate] = useState(defaultBusinessDate);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PosShadowResult | null>(null);
  const [error, setError] = useState("");

  async function run() {
    if (busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/admin/store-settings/pos-shadow", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessDate }),
      });
      if (response.status === 401) {
        localStorage.removeItem("baba_user");
        window.location.href = "/login";
        return;
      }
      const payload = await response.json() as ApiResponse;
      if (!response.ok || !payload.ok) {
        setError(response.status === 403 ? t.forbidden : t.error);
        return;
      }
      setResult(payload.result);
    } catch { setError(t.error); }
    finally { setBusy(false); }
  }

  const classificationMatches = result
    ? result.businessDateComparison.legacyConfiguredMismatchCount === 0
      && result.businessDateComparison.pureDbMismatchCount === 0
      && result.rangeSetComparison.idSetsMatch
    : false;
  const statusText = result?.status === "ready" ? t.ready : result?.status === "mismatch" ? t.mismatch : result ? t.incomplete : "";
  const tone = result?.status === "ready" ? "#166534" : result?.status === "mismatch" ? "#b91c1c" : "#92400e";

  return <details style={styles.panel}>
    <summary style={styles.summary}><span><b>{t.title}</b><small style={styles.readOnly}>{t.readOnly}</small></span><span aria-hidden="true">⌄</span></summary>
    <div style={styles.body}>
      <p style={styles.description}>{t.description}</p>
      <div style={styles.controls}>
        <label style={styles.label}>{t.date}<input type="date" value={businessDate} disabled={busy} onChange={(event)=>setBusinessDate(event.target.value)} style={styles.input}/></label>
        <button type="button" disabled={busy || !businessDate} onClick={run} style={{...styles.button,opacity:busy?.65:1}}>{busy?`⏳ ${t.running}`:t.run}</button>
      </div>
      {error?<p role="alert" style={styles.error}>{error}</p>:null}
      {result?<div aria-live="polite" style={styles.result}>
        <strong style={{...styles.verdict,color:tone}}>{statusText}</strong>
        <div style={styles.metrics}>
          <Metric label={t.setting} value={result.businessDateComparison.pureDbMismatchCount===0?t.match:t.mismatch}/>
          <Metric label={t.range} value={result.window.matches?t.match:t.mismatch}/>
          <Metric label={t.receipts} value={`${result.businessDateComparison.legacyConfiguredMatchCount}/${result.businessDateComparison.comparableCount} ${classificationMatches?t.match:t.mismatch}`}/>
          <Metric label={t.missing} value={`${result.cukcuk.missingTimestampCount + result.cukcuk.detailFailureCount}`}/>
        </div>
        {result.cukcuk.limitReached?<p style={styles.notice}>{t.limit}</p>:null}
        <details style={styles.technical}><summary>{t.details}</summary><dl style={styles.dl}>
          <dt>{t.revision}</dt><dd>{result.setting.revision}</dd>
          <dt>{t.fallback}</dt><dd>{result.setting.isFallback?"Yes":"No"}</dd>
          <dt>Legacy</dt><dd>{result.window.legacy.from} → {result.window.legacy.to}</dd>
          <dt>Configured</dt><dd>{result.window.configured.from ?? "-"} → {result.window.configured.to}</dd>
        </dl></details>
      </div>:null}
    </div>
  </details>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div style={styles.metric}><span>{label}</span><strong>{value}</strong></div>;
}

const styles: Record<string, React.CSSProperties> = {
  panel:{background:"#fff",border:"1px solid #dbe3ec",borderRadius:16,marginBottom:16,overflow:"hidden"},
  summary:{alignItems:"center",cursor:"pointer",display:"flex",justifyContent:"space-between",listStyle:"none",padding:"16px 18px"},
  readOnly:{background:"#e0f2fe",borderRadius:999,color:"#075985",display:"inline-block",fontSize:11,marginLeft:8,padding:"3px 7px"},
  body:{borderTop:"1px solid #e5e7eb",padding:16},description:{color:"#64748b",fontSize:13,lineHeight:1.55,margin:"0 0 14px"},
  controls:{alignItems:"end",display:"grid",gap:10,gridTemplateColumns:"minmax(0,1fr) auto"},
  label:{color:"#475569",display:"grid",fontSize:12,fontWeight:700,gap:5},input:{border:"1px solid #cbd5e1",borderRadius:9,fontSize:15,minWidth:0,padding:"10px"},
  button:{background:"#2563eb",border:0,borderRadius:9,color:"#fff",cursor:"pointer",fontWeight:700,minHeight:42,padding:"0 14px",whiteSpace:"nowrap"},
  error:{background:"#fef2f2",borderRadius:9,color:"#b91c1c",fontSize:13,padding:10},result:{marginTop:14},verdict:{display:"block",marginBottom:10},
  metrics:{display:"grid",gap:8,gridTemplateColumns:"repeat(2,minmax(0,1fr))"},metric:{background:"#f8fafc",borderRadius:9,display:"grid",fontSize:12,gap:3,padding:10},
  notice:{color:"#92400e",fontSize:12},technical:{color:"#475569",fontSize:12,marginTop:12},dl:{display:"grid",gap:"6px 10px",gridTemplateColumns:"auto minmax(0,1fr)",overflowWrap:"anywhere"},
};
