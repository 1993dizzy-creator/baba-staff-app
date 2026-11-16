"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import Container from "@/components/Container";
import LoadingState from "@/components/LoadingState";
import { useLanguage } from "@/lib/language-context";
import { formatVnd } from "@/lib/payroll/payroll-page-money";

// 2026-10 special settlement (Owner only). Records the accountant-corrected payroll
// that was ALREADY paid on 11/10 (bank + cash) and 11/14 (cash). No money is sent.
type Allocation = { paymentDate: string; fundAccountId: number; amount: number; kind: "salary" | "penalty_refund"; note: string | null };
type Row = { userId: number; employeeName: string; calculatedNetAmount: number | null; actualPaidAmount: number; differenceAmount: number | null; differenceReason: string | null; allocations: Allocation[]; paymentStatus: "unpaid" | "paid"; isPayable: boolean; failureCodes: string[] };
type Group = { paymentDate: string; fundAccountId: number; amount: number };
type Preview = { ok: true; planHash: string; batch: { id: number; status: string } | null; rows: Row[]; blockers: string[]; previewToken: string; groups: Group[]; residuals: Array<Group & { reason: string }>;
  totals: { employeeCount: number; unpaidCount: number; calculatedNetTotal: number; actualPaidTotal: number; residualTotal: number; cashOutflowTotal: number } };
type Load = { status: "loading" } | { status: "error"; code: string; detail?: unknown } | { status: "ready"; preview: Preview };

const API = "/api/admin/payroll/special-settlements/2026-10";
const accountLabel = (id: number, vi: boolean) => id === 1 ? (vi ? "Tiền mặt cửa hàng" : "매장 현금") : id === 2 ? (vi ? "TK công ty BABA" : "BABA 법인계좌") : `#${id}`;

export default function SpecialSettlement202610Page() {
  const { lang } = useLanguage(); const vi = lang === "vi";
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(API, { cache: "no-store", signal: controller.signal }).catch(() => null);
      const data = await response?.json().catch(() => null);
      if (controller.signal.aborted) return;
      setLoad(response?.ok && data?.ok ? { status: "ready", preview: data as Preview } : { status: "error", code: String(data?.code ?? "LOAD_FAILED"), detail: data?.errors ?? data?.blockers });
    })();
    return () => controller.abort();
  }, [reloadKey]);
  const refresh = useCallback(() => { setLoad({ status: "loading" }); setReloadKey(key => key + 1); }, []);

  async function execute(preview: Preview) {
    const message = vi
      ? `Ghi nhận ${preview.totals.unpaidCount} nhân viên là đã chi trả (không chuyển tiền lại). Tiếp tục?`
      : `${preview.totals.unpaidCount}명을 지급완료로 기록합니다. 실제 송금은 하지 않으며, 이미 지급된 내역을 지급일·계좌별로 장부에 반영합니다. 진행할까요?`;
    if (!window.confirm(message)) return;
    setBusy(true); setResult(null);
    const requestKey = `oct2026-${crypto.randomUUID()}`;
    const response = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewToken: preview.previewToken, requestKey, confirm: true }) }).catch(() => null);
    const data = await response?.json().catch(() => null);
    setBusy(false);
    setResult(response?.ok && data?.ok ? (vi ? "Đã ghi nhận." : `완료: ${data.result?.paidEmployeeCount}/${data.result?.targetEmployeeCount}명 · ${data.result?.status}`) : `${vi ? "Thất bại" : "실패"}: ${data?.code ?? "NETWORK"} — ${vi ? "kiểm tra lại trạng thái trước khi thử lại" : "재시도 전 상태를 다시 조회하세요"}`);
    refresh();
  }

  if (load.status === "loading") return <LoadingState label={vi ? "Đang tải…" : "불러오는 중…"} variant="page" />;
  return (
    <Container>
      <h1 style={s.title}>{vi ? "Quyết toán đặc biệt lương 10/2026" : "2026년 10월 급여 특별 정산"}</h1>
      <p style={s.note}>{vi ? "Số tiền chính thức: bảng lương đã chỉnh sửa của kế toán. Chỉ ghi nhận khoản đã chi, không chuyển tiền." : "금액 정본: 회계사 정정본. 이미 지급된 급여를 실제 지급일·출금계좌 기준으로 기록하며 송금하지 않습니다."}</p>
      {load.status === "error" ? (
        <div style={s.error}><b>{load.code}</b><pre style={s.pre}>{load.detail ? JSON.stringify(load.detail, null, 1) : ""}</pre><button style={s.button} onClick={refresh}>{vi ? "Tải lại" : "다시 조회"}</button></div>
      ) : (() => {
        const p = load.preview;
        return (<>
          <section style={s.box}>
            <div>{vi ? "Nhân viên" : "대상"} {p.totals.employeeCount} · {vi ? "chưa ghi nhận" : "미기록"} {p.totals.unpaidCount} · {vi ? "lô" : "배치"} {p.batch ? `#${p.batch.id} ${p.batch.status}` : "—"}</div>
            <div>{vi ? "APP tính" : "APP 계산"} {formatVnd(p.totals.calculatedNetTotal)} · {vi ? "thực chi" : "실지급"} {formatVnd(p.totals.actualPaidTotal)} · {vi ? "chênh lệch làm tròn" : "반올림 잔차"} {formatVnd(p.totals.residualTotal)} · {vi ? "tổng chi" : "총 출금"} <b>{formatVnd(p.totals.cashOutflowTotal)}</b></div>
            <ul style={s.list}>{p.groups.map(g => <li key={`${g.paymentDate}:${g.fundAccountId}`}>{g.paymentDate} · {accountLabel(g.fundAccountId, vi)} · <b>{formatVnd(g.amount)}</b></li>)}</ul>
            {p.residuals.map(r => <div key={`${r.paymentDate}:${r.fundAccountId}`} style={s.small}>{r.paymentDate} · {accountLabel(r.fundAccountId, vi)} · {formatVnd(r.amount)} — {r.reason}</div>)}
          </section>
          {p.blockers.length > 0 && <div style={s.error}><b>{vi ? "Không thể thực hiện" : "실행 불가"}</b><ul style={s.list}>{p.blockers.map(b => <li key={b}>{b}</li>)}</ul></div>}
          <div style={s.tableWrap}><table style={s.table}><thead><tr>
            <th style={s.th}>ID</th><th style={s.th}>{vi ? "Nhân viên" : "직원"}</th><th style={s.th}>{vi ? "APP tính" : "APP 계산"}</th><th style={s.th}>{vi ? "Thực chi" : "실지급"}</th><th style={s.th}>{vi ? "Chênh lệch" : "차액"}</th><th style={s.th}>{vi ? "Ngày · TK" : "지급일·계좌"}</th><th style={s.th}>{vi ? "Trạng thái" : "상태"}</th>
          </tr></thead><tbody>{p.rows.map(r => (
            <tr key={r.userId}>
              <td style={s.td}>{r.userId}</td><td style={s.td}>{r.employeeName}</td>
              <td style={s.tdNum}>{r.calculatedNetAmount === null ? "—" : formatVnd(r.calculatedNetAmount)}</td>
              <td style={s.tdNum}>{formatVnd(r.actualPaidAmount)}</td>
              <td style={{ ...s.tdNum, color: r.differenceAmount ? "#b45309" : undefined }} title={r.differenceReason ?? ""}>{r.differenceAmount === null ? "—" : r.differenceAmount === 0 ? "0" : formatVnd(r.differenceAmount)}</td>
              <td style={s.td}>{r.allocations.map(a => <div key={`${a.paymentDate}:${a.fundAccountId}`}>{a.paymentDate.slice(5)} · {accountLabel(a.fundAccountId, vi)} · {formatVnd(a.amount)}{a.kind === "penalty_refund" ? (vi ? " (hoàn phạt)" : " (패널티 반환)") : ""}</div>)}</td>
              <td style={s.td}>{r.paymentStatus === "paid" ? (vi ? "Đã ghi nhận" : "기록됨") : r.failureCodes.length ? r.failureCodes.join(", ") : (vi ? "Sẵn sàng" : "준비")}</td>
            </tr>))}</tbody></table></div>
          <button style={{ ...s.button, ...s.primary }} disabled={busy || p.blockers.length > 0} onClick={() => void execute(p)}>
            {busy ? "…" : vi ? "Ghi nhận đã chi trả" : `${p.totals.unpaidCount}명 지급완료 기록`}
          </button>
          {result && <p style={s.note}>{result}</p>}
        </>);
      })()}
    </Container>
  );
}

const s: Record<string, CSSProperties> = {
  title: { fontSize: 20, fontWeight: 700, margin: "12px 0 4px" },
  note: { fontSize: 13, color: "#555", margin: "4px 0 12px" },
  small: { fontSize: 12, color: "#666" },
  box: { border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 14, display: "grid", gap: 6 },
  list: { margin: 0, paddingLeft: 18 },
  error: { border: "1px solid #f3b4b4", background: "#fff5f5", borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 13 },
  pre: { whiteSpace: "pre-wrap", fontSize: 12, margin: "6px 0" },
  tableWrap: { overflowX: "auto", marginBottom: 12 },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", borderBottom: "1px solid #ddd", padding: "6px 4px", whiteSpace: "nowrap" },
  td: { borderBottom: "1px solid #eee", padding: "6px 4px", verticalAlign: "top" },
  tdNum: { borderBottom: "1px solid #eee", padding: "6px 4px", textAlign: "right", whiteSpace: "nowrap", verticalAlign: "top" },
  button: { padding: "8px 14px", borderRadius: 8, border: "1px solid #ccc", background: "#fff", cursor: "pointer", fontSize: 14 },
  primary: { background: "#111", color: "#fff", borderColor: "#111" },
};
