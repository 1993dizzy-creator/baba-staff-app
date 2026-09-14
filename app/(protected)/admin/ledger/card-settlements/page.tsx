"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import Container from "@/components/Container";
import { BarSheet } from "@/components/bar/keeping/KeepingUi";
import styles from "./card-settlements.module.css";
import { buildEditableCardSales, cardMoney, recommendCardAllocations, sumCardMoney } from "@/lib/ledger/card-settlements";
type Account = { id: number; code: string; display_name: string };
type Sale = { id: number; business_date: string; amount: number; allocatedGrossAmount: number; outstandingGrossAmount: number };
type Rec = { id: number; deposit_date: string; deposit_amount: number; matched_gross_amount: number; difference_amount: number; status: string; memo: string | null; destination: { display_name: string } | null };
type Data = { accounts: Account[]; sales: Sale[]; monthlySales: Sale[]; priorUnreconciledSales: Sale[]; totalReconciliationCount:number; reconciliations: Rec[]; summary: { monthlyCardGross: number; monthlyReconciledGross: number; monthlySettledGross:number; monthlyUnreconciledGross: number; totalUnreconciledGross: number; cardPendingBalance: number; actualCardDeposits: number; monthlyUnmatchedDeposits: number; monthlyCompletedGross: number; monthlyCompletedDeposit: number; monthlyCompletedDifference: number; actualDifferenceRate: number | null } };
type SavedLine = { pos_card_transaction_id: number; allocated_gross_amount: number; sale: Sale | null };
const monthNow = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const localNow = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);
const money = (n: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n)} ₫`;
const shortDate = (date:string) => `${date.slice(5,7)}/${date.slice(8,10)}`;
const statusName: Record<string, string> = { unmatched: "미연결", partial: "부분 저장", matched: "정산 완료" };
export default function CardSettlementsPage() {
  const [month, setMonth] = useState(monthNow), [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState(""), [working, setWorking] = useState(false);
  const [depositAt, setDepositAt] = useState(localNow), [amount, setAmount] = useState(""), [accountId, setAccountId] = useState("");
  const [reference, setReference] = useState(""), [memo, setMemo] = useState("");
  const [selected, setSelected] = useState<number | null>(null), [allocations, setAllocations] = useState<Record<number, string>>({});
  const [editableSales, setEditableSales] = useState<Sale[]>([]), [expectedFee, setExpectedFee] = useState("1.8");
  const [drilldown, setDrilldown] = useState<Record<string, unknown> | null>(null);
  const [createOpen,setCreateOpen]=useState(false), [inspectedDeposit,setInspectedDeposit]=useState<Rec|null>(null);
  const createButtonRef=useRef<HTMLButtonElement>(null), depositButtonRef=useRef<HTMLButtonElement|null>(null);
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
      setAmount(""); setReference(""); setMemo(""); setCreateOpen(false); setMessage("카드 입금을 등록했습니다."); await load();
    } catch (e) { setMessage(`등록 실패: ${(e as Error).message}`); } finally { setWorking(false); }
  }
  const validFee = expectedFee.trim() !== "" && Number.isFinite(Number(expectedFee)) && Number(expectedFee) >= 0 && Number(expectedFee) < 100;
  function recommend(rec: Rec, sales = editableSales) {
    if (!validFee) { setMessage("예상 수수료율을 0 이상 100 미만으로 입력해주세요."); return; }
    const plan = recommendCardAllocations(sales, Number(rec.deposit_amount), Number(expectedFee) / 100);
    setAllocations(Object.fromEntries(plan.allocations.map(row => [row.transactionId, String(row.allocatedGrossAmount)])));
    setMessage(plan.unallocatedGross > 0 ? `추천 정산 대상 ${money(plan.targetGross)} · 매출 잔액 부족 ${money(plan.unallocatedGross)}. 연결액을 확인해주세요.` : `추천 정산 대상 ${money(plan.targetGross)}. 확정 전 연결액과 차액률을 확인해주세요.`);
  }
  async function open(rec: Rec) {
    const version = ++openVersion.current; setWorking(true); setSelected(null); setInspectedDeposit(null);
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
  const closeMatch=()=>{if(working)return;++openVersion.current;setSelected(null);setAllocations({});setEditableSales([]);setDrilldown(null);};
  return <Container noPaddingTop noPaddingBottom><main className={styles.page}>
    <header className={styles.header}>
      <div className={styles.headerLine}><Link href="/admin/ledger/entries" className={styles.backLink}>← 장부작성</Link><h1>💳 카드 정산</h1></div>
      <label className={styles.monthField}><span>선택 월</span><input type="month" disabled={working} value={month} onChange={e=>{++openVersion.current;setMonth(e.target.value);setData(null);setSelected(null);setAllocations({});setEditableSales([]);setInspectedDeposit(null);setCreateOpen(false);setDrilldown(null);setMessage("");}} className={styles.input}/></label>
    </header>
    {message&&!rec&&!createOpen?<p role="status" className={styles.notice}>{message}</p>:null}
    {data?<>
      <section className={styles.card} aria-label="카드매출 발생월 기준">
        <h2>카드 현황 ({Number(month.slice(5,7))}월)</h2>
        <div className={styles.grid}>
          <Card title="💳 카드매출" value={money(data.summary.monthlyCardGross)}/>
          <Card title="✅ 정산완료" value={money(data.summary.monthlySettledGross)}/>
          <Card title="⏳ 미정산" value={money(data.summary.monthlyUnreconciledGross)}/>
          <Card title="🌐 전체 미정산" value={money(data.summary.totalUnreconciledGross)}/>
        </div>
      </section>
      <details className={styles.card}><summary className={styles.summary}><span>⏳ 미정산 카드매출</span><strong>{money(data.summary.monthlyUnreconciledGross)}</strong><i aria-hidden="true">⌄</i></summary>
        <p className={styles.hint}>매출월 기준 · 매출별 정산완료 금액은 부분 저장 포함</p>
        <CardSalesList sales={data.monthlySales} onPos={openPos} empty="선택월 카드매출이 없습니다."/>
      </details>
      {data.priorUnreconciledSales.length?<details className={styles.card}><summary className={styles.summary}><span>↪️ 이전월 미정산</span><strong>{money(sumCardMoney(data.priorUnreconciledSales.map(sale=>sale.outstandingGrossAmount)))}</strong><i aria-hidden="true">⌄</i></summary>
        <CardSalesList sales={data.priorUnreconciledSales} onPos={openPos} empty="이전월 미정산이 없습니다."/>
      </details>:null}
      <button ref={createButtonRef} type="button" disabled={working} className={styles.primary} onClick={()=>{setMessage("");setCreateOpen(true);}}>＋ 카드 입금 등록</button>
      <section className={styles.card} aria-label="카드입금월 기준">
        <h2>🏦 카드 입금 내역</h2>
        <div className={styles.depositTotals}><span>입금 {money(data.summary.actualCardDeposits)}</span><span>차액 {money(data.summary.monthlyCompletedDifference)}</span></div>
        {data.reconciliations.length===0?<p className={styles.empty}>등록된 카드 입금이 없습니다.</p>:<div className={styles.list}>{data.reconciliations.map(row=><article key={row.id} className={styles.depositRow}>
          <button type="button" disabled={working} className={styles.depositDetail} onClick={e=>{depositButtonRef.current=e.currentTarget;setInspectedDeposit(row);}}>
            <time dateTime={row.deposit_date}>{shortDate(row.deposit_date)}</time><strong>{money(Number(row.deposit_amount))}</strong><span className={styles.statusBadge+" "+(row.status==="matched"?styles.completedBadge:"")}>{statusName[row.status]??row.status}</span><i aria-hidden="true">›</i>
          </button>
          {["unmatched","partial"].includes(row.status)?<button type="button" disabled={working} className={styles.secondary} onClick={e=>{depositButtonRef.current=e.currentTarget;setMessage("");void open(row);}}>매출 연결{row.status==="partial"?" 수정":""}</button>:null}
        </article>)}</div>}
      </section>
      {createOpen?<BarSheet kind="bottom" compact title="카드 입금 등록" closeLabel="닫기" saving={working} onClose={()=>setCreateOpen(false)} returnFocusRef={createButtonRef} footer={<button form="card-deposit-form" type="submit" disabled={working} className={styles.primary}>입금 등록</button>}>
        {message?<p role="status" className={styles.notice}>{message}</p>:null}
        <form id="card-deposit-form" onSubmit={create} className={styles.formGrid}>
          <label>입금일<input required type="datetime-local" disabled={working} value={depositAt} onChange={e=>setDepositAt(e.target.value)} className={styles.input}/></label>
          <label>실제 입금액<input required type="number" disabled={working} min="0.001" step="0.001" value={amount} onChange={e=>setAmount(e.target.value)} className={styles.input}/></label>
          <label>입금계정<select required disabled={working} value={accountId} onChange={e=>setAccountId(e.target.value)} className={styles.input}><option value="">선택</option>{data.accounts.filter(account=>account.code!=="card_clearing").map(account=><option key={account.id} value={account.id}>{account.display_name}</option>)}</select></label>
          <label>Reference<input disabled={working} value={reference} onChange={e=>setReference(e.target.value)} className={styles.input}/></label>
          <label>메모<input disabled={working} value={memo} onChange={e=>setMemo(e.target.value)} className={styles.input}/></label>
        </form>
      </BarSheet>:null}
      {inspectedDeposit?<BarSheet kind="bottom" compact title={inspectedDeposit.deposit_date+" 카드 입금"} closeLabel="닫기" saving={working} onClose={()=>setInspectedDeposit(null)} returnFocusRef={depositButtonRef} footer={["unmatched","partial"].includes(inspectedDeposit.status)?<button type="button" disabled={working} className={styles.primary} onClick={()=>{setMessage("");void open(inspectedDeposit);}}>매출 연결{inspectedDeposit.status==="partial"?" 수정":""}</button>:<button type="button" className={styles.secondary} onClick={()=>setInspectedDeposit(null)}>닫기</button>}>
        <div className={styles.grid}><Card title="실제 입금" value={money(Number(inspectedDeposit.deposit_amount))}/><Card title="정산연결" value={money(Number(inspectedDeposit.matched_gross_amount))}/><Card title="정산 차액" value={money(Number(inspectedDeposit.difference_amount))}/><Card title="상태" value={statusName[inspectedDeposit.status]??inspectedDeposit.status}/></div>
        <p className={styles.hint}>{inspectedDeposit.destination?.display_name??"-"}</p>{inspectedDeposit.memo?<p className={styles.hint}>{inspectedDeposit.memo}</p>:null}
      </BarSheet>:null}
      {rec?<BarSheet kind="full" compact topAligned fillAvailable title={shortDate(rec.deposit_date)+" 매출 연결"} closeLabel="닫기" saving={working} onClose={closeMatch} returnFocusRef={depositButtonRef} footer={<div className={styles.actions}><button type="button" disabled={working||invalidAllocation||gross<=0} className={styles.secondary} onClick={()=>void match(false)}>부분 저장</button><button type="button" disabled={working||invalidAllocation||gross<=0||gross<Number(rec.deposit_amount)} className={styles.primary} onClick={()=>void match(true)}>정산 확정</button></div>}>
        <div className={styles.sheetBody}>
        {message?<p role="status" className={styles.notice}>{message}</p>:null}
        <div className={styles.grid} aria-label="정산 확정 전 확인">
          <Card title="실제 입금" value={money(Number(rec.deposit_amount))}/><Card title="정산 대상" value={money(gross)}/>
          <Card title="정산 차액" value={money(difference)}/><Card title="정산 차액률" value={differenceRate===null?"-":(differenceRate*100).toFixed(3)+"%"}/>
        </div>
        <div className={styles.recommendation}>
          <label>예상 수수료율 (%)<input type="number" disabled={working} min="0" max="99.999" step="0.001" value={expectedFee} onChange={e=>setExpectedFee(e.target.value)} className={styles.input}/></label>
          <button type="button" disabled={working||!validFee} className={styles.secondary} onClick={()=>recommend(rec)}>오래된 매출부터 추천</button>
        </div>
        <p className={styles.hint}>예상 수수료율은 추천용 · 입력액은 현재 입금의 연결액</p>
        {invalidAllocation?<p role="alert" className={styles.validation}>연결액은 미정산 잔액 이하, 소수점 3자리까지 입력해주세요.</p>:null}
        {gross<Number(rec.deposit_amount)?<p className={styles.validation}>정산 대상이 입금액보다 작습니다. 부분 저장만 가능합니다.</p>:null}
        {editableSales.length===0?<p className={styles.empty}>연결 가능한 미정산 매출이 없습니다.</p>:null}
        <div className={styles.list}>{editableSales.map(sale=><article key={sale.id} className={styles.saleRow}>
          <div className={styles.saleHeading}><time dateTime={sale.business_date}>{shortDate(sale.business_date)}</time><button type="button" disabled={working} className={styles.secondary} onClick={()=>void openPos(sale.id)}>POS 상세</button></div>
          <SaleGrossMetrics sale={sale}/>
          <label className={styles.allocationRow}><span>연결액</span><input aria-label={sale.business_date+" 연결액"} type="number" disabled={working} min="0" max={sale.outstandingGrossAmount} step="0.001" value={allocations[sale.id]??""} onChange={e=>setAllocations(current=>({...current,[sale.id]:e.target.value}))} className={styles.input}/></label>
        </article>)}</div>
        </div>
      </BarSheet>:null}
      {drilldown?<BarSheet kind="full" compact topAligned title="POS 카드매출 상세" closeLabel="닫기" onClose={()=>setDrilldown(null)} footer={<button type="button" className={styles.secondary} onClick={()=>setDrilldown(null)}>닫기</button>}>
        <p className={styles.hint}>원본 {money(Number(drilldown.sourceAmount??0))} · 장부 {money(Number(drilldown.ledgerAmount??0))}</p>
        {((drilldown.payments as Array<Record<string,unknown>>)||[]).map((payment,i)=><p className={styles.hint} key={String(payment.paymentId??i)}>{String(payment.refNo??"-")} · {String(payment.refDate??"-")} · {String(payment.paymentMethod??"-")} · {money(Number(payment.paymentAmount??0))}</p>)}
      </BarSheet>:null}
    </>:<p className={styles.empty}>불러오는 중…</p>}
  </main></Container>;
}
function Card({title,value}:{title:string;value:string}) {return <article className={styles.miniCard}><span>{title}</span><strong>{value}</strong></article>;}
function CardSalesList({sales,onPos,empty}:{sales:Sale[];onPos:(id:number)=>Promise<void>;empty:string}) {
  return <div className={styles.list}>{sales.length?sales.map(sale=><article key={sale.id} className={styles.saleRow}>
    <div className={styles.saleHeading}><time dateTime={sale.business_date}>{shortDate(sale.business_date)}</time><button type="button" className={styles.secondary} onClick={()=>void onPos(sale.id)}>POS 상세</button></div>
    <SaleGrossMetrics sale={sale}/>
  </article>):<p className={styles.empty}>{empty}</p>}</div>;
}
function SaleGrossMetrics({sale}:{sale:Sale}) {
  return <dl className={styles.saleMetrics}><div><dt>카드매출</dt><dd>{money(Number(sale.amount))}</dd></div><div><dt title="부분 저장 포함 연결액">정산완료</dt><dd>{money(sale.allocatedGrossAmount)}</dd></div><div><dt>미정산</dt><dd>{money(sale.outstandingGrossAmount)}</dd></div></dl>;
}
