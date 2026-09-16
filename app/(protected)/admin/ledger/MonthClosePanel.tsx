"use client";

import { useCallback, useEffect, useState } from "react";

type Preflight = {
  canClose: boolean;
  blockers: Array<{ code: string; count?: number; amount?: number }>;
  warnings: Array<{ code: string; count?: number; amount?: number }>;
  preflightHash: string;
};
type Check = {
  state: "open" | "closed" | "reopened";
  snapshotDrift?: boolean;
  currentRecalculation?: Record<string, unknown>;
  currentSummary?: Record<string, unknown>;
  preflight?: Preflight;
  summary?: Record<string, unknown>;
  closure?: {
    revision: number;
    closed_at?: string;
    snapshot_hash?: string;
    summary_snapshot?: Record<string, unknown>;
    previousSnapshotHash?: string;
  };
};

export default function MonthClosePanel({
  month, onState,
}: { month: string; onState?: (closed: boolean) => void }) {
  const [data, setData] = useState<Check | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showReopen, setShowReopen] = useState(false);
  const [reason, setReason] = useState("");
  const monthLabel = `${Number(month.slice(5, 7))}월`;

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`/api/admin/ledger/month-close?month=${month}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code);
      setData(body);
      onState?.(body.state === "closed");
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [month, onState]);
  useEffect(() => { void load(); }, [load]);

  async function close() {
    if (!data?.preflight?.preflightHash) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/ledger/month-close", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close", month, expectedPreflightHash: data.preflight.preflightHash }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code);
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    if (!reason.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/ledger/month-close", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reopen", month, reason: reason.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code);
      setShowReopen(false);
      setReason("");
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <section><h2>월마감</h2><p role={error ? "alert" : undefined}>{error || "점검 중..."}</p></section>;

  if (data.state === "closed") return (
    <section style={box}>
      <h2>월마감 · CLOSED</h2>
      <p>마감 완료: {data.closure?.closed_at} · {data.closure?.revision}차 마감</p>
      <p>Snapshot hash: <code>{data.closure?.snapshot_hash}</code></p>
      {data.snapshotDrift
        ? <p role="alert">마감 후 원본 변경 감지</p>
        : <p>현재 재계산과 마감 Snapshot 일치</p>}
      <details><summary>마감 당시 숫자 (기본)</summary><pre style={pre}>
        {JSON.stringify(data.closure?.summary_snapshot, null, 2)}
      </pre></details>
      <details><summary>현재 재계산</summary><pre style={pre}>
        {JSON.stringify(data.currentRecalculation, null, 2)}
      </pre></details>
      {error && <p role="alert">{error}</p>}
      {!showReopen
        ? <button type="button" onClick={() => setShowReopen(true)}>마감 다시 열기</button>
        : <div style={confirmBox}>
          <p>마감을 다시 열면 이 월의 장부를 수정할 수 있습니다.</p>
          <p>기존 마감본은 이력으로 보존됩니다.</p>
          <label htmlFor="month-reopen-reason">재오픈 사유</label>
          <textarea id="month-reopen-reason" value={reason}
            onChange={(event) => setReason(event.target.value)} rows={3}
            style={{ display: "block", width: "100%", margin: "8px 0" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" disabled={busy || !reason.trim()} onClick={reopen}>
              {busy ? "처리 중..." : "재검토 위해 마감 열기"}
            </button>
            <button type="button" disabled={busy} onClick={() => { setShowReopen(false); setReason(""); }}>취소</button>
          </div>
        </div>}
    </section>
  );

  return (
    <section style={box}>
      <h2>{data.state === "reopened" ? `${monthLabel} 재검토 중` : "월마감 점검 · OPEN"}</h2>
      {data.state === "reopened" && <>
        <p>이전 마감본은 보존되어 있으며 현재 장부는 수정 가능한 상태입니다.</p>
        <p>{data.closure?.revision}차 마감본 보존 · Hash <code>{data.closure?.previousSnapshotHash}</code></p>
      </>}
      {error && <p role="alert">{error}</p>}
      <h3>Blocker</h3>
      {data.preflight?.blockers.length
        ? <ul>{data.preflight.blockers.map((item, index) =>
          <li key={`${item.code}-${index}`}>❌ {item.code}{item.count ? ` (${item.count})` : ""}</li>)}</ul>
        : <p>없음</p>}
      <h3>Warning</h3>
      {data.preflight?.warnings.length
        ? <ul>{data.preflight.warnings.map((item, index) =>
          <li key={`${item.code}-${index}`}>⚠ {item.code}{item.amount ? ` (${item.amount})` : ""}</li>)}</ul>
        : <p>없음</p>}
      <details><summary>마감 Preview</summary><pre style={pre}>
        {JSON.stringify(data.state === "reopened" ? data.currentSummary : data.summary, null, 2)}
      </pre></details>
      <button type="button" disabled={busy || !data.preflight?.canClose} onClick={close}>
        {busy ? "마감 중..." : data.state === "reopened" ? `${monthLabel} 다시 마감` : `${month} 마감 확정`}
      </button>
    </section>
  );
}

const box = { border: "1px solid #ddd", borderRadius: 12, padding: 16, margin: "16px 0" };
const confirmBox = { borderTop: "1px solid #ddd", marginTop: 12, paddingTop: 12 };
const pre = { whiteSpace: "pre-wrap" as const };
