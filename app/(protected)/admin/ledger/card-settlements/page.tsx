"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import Link from "next/link";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import { buildEditableCardSales, cardMoney, recommendCardAllocations, sumCardMoney } from "@/lib/ledger/card-settlements";
type Account = { id: number; code: string; display_name: string };
type Sale = { id: number; business_date: string; amount: number; allocatedGrossAmount: number; outstandingGrossAmount: number };
type Rec = { id: number; deposit_date: string; deposit_amount: number; matched_gross_amount: number; difference_amount: number; status: string; memo: string | null; destination: { display_name: string } | null };
type Data = { accounts: Account[]; sales: Sale[]; reconciliations: Rec[]; summary: { monthlyCardGross: number; monthlyReconciledGross: number; monthlyUnreconciledGross: number; totalUnreconciledGross: number; cardPendingBalance: number; actualCardDeposits: number; monthlyUnmatchedDeposits: number; monthlyCompletedGross: number; monthlyCompletedDeposit: number; monthlyCompletedDifference: number; actualDifferenceRate: number | null } };
type SavedLine = { pos_card_transaction_id: number; allocated_gross_amount: number; sale: Sale | null };
const monthNow = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const localNow = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);
const money = (n: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n);
const statusName: Record<string, string> = { unmatched: "미연결", partial: "부분 저장", matched: "정산 완료" };
export default function CardSettlementsPage() {
  const [month, setMonth] = useState(monthNow), [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState(""), [working, setWorking] = useState(false);
  const [depositAt, setDepositAt] = useState(localNow), [amount, setAmount] = useState(""), [accountId, setAccountId] = useState("");
  const [reference, setReference] = useState(""), [memo, setMemo] = useState("");
  const [selected, setSelected] = useState<number | null>(null), [allocations, setAllocations] = useState<Record<number, string>>({});
  const [editableSales, setEditableSales] = useState<Sale[]>([]), [expectedFee, setExpectedFee] = useState("1.8");
  const [drilldown, setDrilldown] = useState<Record<string, unknown> | null>(null);
  const openVersion = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch(`/api/admin/ledger/card-settlements?month=${month}`, { cache: "no-store", signal }), b = await r.json();
    if (!r.ok) throw new Error(b.code);
    if (!signal?.aborted) setData(b);
  }, [month]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal).catch(e => { if (!controller.signal.aborted) setMessage(e.message); }); return () => controller.abort(); }, [load]);
  async function create(e: FormEvent) {
    e.preventDefault(); setWorking(true);
    try {
      const r = await fetch("/api/admin/ledger/card-settlements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ depositAt: `${depositAt}:00+07:00`, amount: Number(amount), destinationAccountId: Number(accountId), reference, memo }) }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      setAmount(""); setReference(""); setMemo(""); setMessage("카드 입금을 등록했습니다."); await load();
    } catch (e) { setMessage(`등록 실패: ${(e as Error).message}`); } finally { setWorking(false); }
  }
  const validFee = expectedFee.trim() !== "" && Number.isFinite(Number(expectedFee)) && Number(expectedFee) >= 0 && Number(expectedFee) < 100;
  function recommend(rec: Rec, sales = editableSales) {
    if (!validFee) { setMessage("예상 수수료율을 0 이상 100 미만으로 입력해주세요."); return; }
    const plan = recommendCardAllocations(sales, Number(rec.deposit_amount), Number(expectedFee) / 100);
    setAllocations(Object.fromEntries(plan.allocations.map(row => [row.transactionId, String(row.allocatedGrossAmount)])));
    setMessage(plan.unallocatedGross > 0 ? `추천 Gross 목표 ${money(plan.targetGross)} · 매출 잔액 부족 ${money(plan.unallocatedGross)}. 연결액을 확인해주세요.` : `추천 Gross 목표 ${money(plan.targetGross)}. 확정 전 연결액과 차액률을 확인해주세요.`);
  }
  async function open(rec: Rec) {
    const version = ++openVersion.current; setWorking(true); setSelected(null);
    try {
      const r = await fetch(`/api/admin/ledger/card-settlements/${rec.id}`, { cache: "no-store" }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      if (version !== openVersion.current) return;
      if (["matched", "cancelled"].includes(b.reconciliation.status)) throw new Error("이미 확정되었거나 유효하지 않은 정산입니다.");
      const lines: SavedLine[] = b.reconciliation.lines ?? [];
      const sales = buildEditableCardSales(data?.sales ?? [], lines);
      setEditableSales(sales); setSelected(rec.id);
      if (lines.length) { setAllocations(Object.fromEntries(lines.map(line => [line.pos_card_transaction_id, String(line.allocated_gross_amount)]))); setMessage("기존 부분 연결을 불러왔습니다. 저장 시 이 정산의 연결액을 교체합니다."); }
      else { setAllocations({}); recommend(rec, sales); }
    } catch (e) { setMessage(`조회 실패: ${(e as Error).message}`); } finally { if (version === openVersion.current) setWorking(false); }
  }
  const rec = data?.reconciliations.find(row => row.id === selected);
  const invalidAllocation = Object.entries(allocations).some(([id, value]) => {
    if (value === "") return false;
    const numeric = Number(value), sale = editableSales.find(row => row.id === Number(id));
    return !Number.isFinite(numeric) || numeric < 0 || !sale || numeric > sale.outstandingGrossAmount || Math.abs(numeric - cardMoney(numeric)) > 0.0000001;
  });
  const gross = sumCardMoney(Object.values(allocations).filter(value => Number.isFinite(Number(value))));
  const difference = rec ? cardMoney(gross - Number(rec.deposit_amount)) : 0;
  const differenceRate = gross > 0 ? difference / gross : null;
  async function match(confirm: boolean) {
    if (!selected || !rec || invalidAllocation || gross <= 0 || (confirm && gross < Number(rec.deposit_amount))) return;
    setWorking(true);
    try {
      const rows = Object.entries(allocations).filter(([, value]) => Number(value) > 0).map(([transactionId, allocatedGrossAmount]) => ({ transactionId: Number(transactionId), allocatedGrossAmount: Number(allocatedGrossAmount) }));
      const r = await fetch(`/api/admin/ledger/card-settlements/${selected}/match`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allocations: rows, confirm }) }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      setMessage(confirm ? `정산 완료 · 차액 ${money(Number(b.result.differenceAmount))}` : "부분 매칭을 저장했습니다.");
      setSelected(null); setAllocations({}); setEditableSales([]); await load();
    } catch (e) { setMessage(`매칭 실패: ${(e as Error).message}`); } finally { setWorking(false); }
  }
  async function openPos(id: number) {
    try {
      const r = await fetch(`/api/admin/ledger/transactions/${id}/pos-drilldown`, { cache: "no-store" }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      setDrilldown(b.drilldown);
    } catch (e) { setMessage(`POS 조회 실패: ${(e as Error).message}`); }
  }
  return <Container><main style={s.page}>
    <header><Link href="/admin/ledger">← 장부</Link><h1>카드 정산</h1><p>카드매출은 매출 발생월, 실제 입금과 완료 차액은 입금월 기준입니다.</p></header>
    <label>선택 월 <input type="month" disabled={working} value={month} onChange={e => { ++openVersion.current; setMonth(e.target.value); setData(null); setSelected(null); setAllocations({}); setEditableSales([]); setMessage(""); }} style={s.input} /></label>
    {message ? <p role="status">{message}</p> : null}
    {data ? <>
      <section style={s.grid} aria-label="카드매출 발생월 기준">
        <Card title="선택월 카드매출" value={money(data.summary.monthlyCardGross)} />
        <Card title="선택월 정산연결 Gross" value={money(data.summary.monthlyReconciledGross)} />
        <Card title="선택월 미정산 카드" value={money(data.summary.monthlyUnreconciledGross)} />
        <Card title="전체 미정산 카드" value={money(data.summary.totalUnreconciledGross)} />
        <Card title="카드미정산 계정 잔액" value={money(data.summary.cardPendingBalance)} />
      </section>
      <section style={s.grid} aria-label="카드입금월 기준">
        <Card title="선택월 실제 카드입금" value={money(data.summary.actualCardDeposits)} />
        <Card title="선택월 미완료 카드입금" value={money(data.summary.monthlyUnmatchedDeposits)} />
        <Card title="선택월 완료 Gross" value={money(data.summary.monthlyCompletedGross)} />
        <Card title="선택월 완료 입금액" value={money(data.summary.monthlyCompletedDeposit)} />
        <Card title="선택월 정산 차액" value={money(data.summary.monthlyCompletedDifference)} />
        <Card title="선택월 완료 차액률" value={data.summary.actualDifferenceRate === null ? "-" : `${(data.summary.actualDifferenceRate * 100).toFixed(3)}%`} />
      </section>
      <form onSubmit={create} style={s.card}><h2>카드 입금 등록</h2>
        <label>입금일<input required type="datetime-local" disabled={working} value={depositAt} onChange={e => setDepositAt(e.target.value)} style={s.input} /></label>
        <label>실제 입금액<input required type="number" disabled={working} min="0.001" step="0.001" value={amount} onChange={e => setAmount(e.target.value)} style={s.input} /></label>
        <label>입금 자금계정<select required disabled={working} value={accountId} onChange={e => setAccountId(e.target.value)} style={s.input}><option value="">선택</option>{data.accounts.filter(account => account.code !== "card_clearing").map(account => <option key={account.id} value={account.id}>{account.display_name}</option>)}</select></label>
        <label>Reference<input disabled={working} value={reference} onChange={e => setReference(e.target.value)} style={s.input} /></label>
        <label>메모<input disabled={working} value={memo} onChange={e => setMemo(e.target.value)} style={s.input} /></label>
        <button disabled={working} style={s.primary}>입금 등록</button>
      </form>
      <section><h2>선택월 카드 입금</h2><div style={s.list}>
        {data.reconciliations.length === 0 ? <p>선택월에 등록된 카드 입금이 없습니다.</p> : null}
        {data.reconciliations.map(row => <article key={row.id} style={s.card}>
          <strong>{row.deposit_date} · 실제 입금 {money(Number(row.deposit_amount))}</strong>
          <span>{row.destination?.display_name ?? "-"} · {statusName[row.status] ?? row.status}</span>
          <span>연결 Gross {money(Number(row.matched_gross_amount))} · 확정 차액 {money(Number(row.difference_amount))}</span>
          {row.memo ? <span>{row.memo}</span> : null}
          {["unmatched", "partial"].includes(row.status) ? <button type="button" disabled={working} style={s.secondary} onClick={() => void open(row)}>매출 연결{row.status === "partial" ? " 수정" : ""}</button> : null}
        </article>)}
      </div></section>
      {rec ? <section style={s.card}><h2>{rec.deposit_date} 입금 매칭</h2>
        <label>추천용 예상 카드수수료율 (%)<input type="number" disabled={working} min="0" max="99.999" step="0.001" value={expectedFee} onChange={e => setExpectedFee(e.target.value)} style={s.input} /></label>
        <p>예상 수수료율은 추천에만 사용합니다. 실제 차액은 선택 Gross − 실제 입금으로 계산합니다.</p>
        <button type="button" disabled={working || !validFee} style={s.secondary} onClick={() => recommend(rec)}>오래된 매출부터 추천</button>
        <div style={s.grid} aria-label="정산 확정 전 확인">
          <Card title="선택 Gross" value={money(gross)} /><Card title="실제 입금" value={money(Number(rec.deposit_amount))} />
          <Card title="정산 차액 (Gross − 입금)" value={money(difference)} />
          <Card title="차액률 (차액 / Gross)" value={differenceRate === null ? "-" : `${(differenceRate * 100).toFixed(3)}%`} />
        </div>
        <p>전체 기간의 미정산 매출을 오래된 순서로 표시합니다. 이미 연결된 Gross는 다른 정산의 연결액이며, 현재 정산 연결액은 입력란에서 수정합니다.</p>
        {editableSales.length === 0 ? <p>연결 가능한 미정산 카드매출이 없습니다.</p> : null}
        {editableSales.map(sale => <div key={sale.id} style={s.card}>
          <strong>영업일 {sale.business_date}</strong>
          <span>원 Gross {money(Number(sale.amount))} · 이미 연결된 Gross {money(sale.allocatedGrossAmount)} · 남은 Gross {money(sale.outstandingGrossAmount)}</span>
          <label>현재 정산 연결 Gross<input type="number" disabled={working} min="0" max={sale.outstandingGrossAmount} step="0.001" value={allocations[sale.id] ?? ""} onChange={e => setAllocations(current => ({ ...current, [sale.id]: e.target.value }))} style={s.input} /></label>
          <button type="button" style={s.secondary} onClick={() => void openPos(sale.id)}>POS 상세</button>
        </div>)}
        {invalidAllocation ? <p role="alert">연결액은 남은 Gross 이하의 0 이상 금액으로, 소수점 3자리까지 입력해주세요.</p> : null}
        {gross < Number(rec.deposit_amount) ? <p>선택 Gross가 실제 입금보다 작습니다. 부분 저장은 가능하지만 정산 확정은 할 수 없습니다.</p> : null}
        <div style={s.actions}><button type="button" disabled={working || invalidAllocation || gross <= 0} style={s.secondary} onClick={() => void match(false)}>부분 저장</button><button type="button" disabled={working || invalidAllocation || gross <= 0 || gross < Number(rec.deposit_amount)} style={s.primary} onClick={() => void match(true)}>정산 확정</button></div>
      </section> : null}
      {drilldown ? <section style={s.card}><h2>POS 카드매출 상세</h2><p>원본 {money(Number(drilldown.sourceAmount ?? 0))} · 장부 {money(Number(drilldown.ledgerAmount ?? 0))}</p>
        {((drilldown.payments as Array<Record<string, unknown>>) || []).map((payment, i) => <span key={String(payment.paymentId ?? i)}>{String(payment.refNo ?? "-")} · {String(payment.refDate ?? "-")} · {String(payment.paymentMethod ?? "-")} · {money(Number(payment.paymentAmount ?? 0))}</span>)}
        <button type="button" style={s.secondary} onClick={() => setDrilldown(null)}>닫기</button>
      </section> : null}
    </> : <p>카드 정산 정보를 불러오는 중입니다.</p>}
  </main></Container>;
}
function Card({ title, value }: { title: string; value: string }) { return <article style={s.card}><span>{title}</span><strong>{value}</strong></article>; }
const s = { page: { display: "grid", gap: 16, paddingBottom: 24 }, grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 8 }, card: { ...ui.card, padding: 12, display: "grid", gap: 8 }, list: { display: "grid", gap: 8 }, input: { ...ui.input, width: "100%" }, actions: { display: "flex", gap: 8, flexWrap: "wrap" }, primary: { ...ui.button, width: "auto", padding: "9px 13px" }, secondary: { ...ui.subButton, width: "auto", padding: "8px 11px" } } satisfies Record<string, CSSProperties>;
