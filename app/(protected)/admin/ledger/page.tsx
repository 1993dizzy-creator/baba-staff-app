"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import Container from "@/components/Container";
import { ui } from "@/lib/styles/ui";
import InventoryCandidatePanel from "./InventoryCandidatePanel";
import RecurringReserveBepPanel from "./RecurringReserveBepPanel";
import MonthClosePanel from "./MonthClosePanel";

type Account = { id: number; display_name: string; balance: number; is_active: boolean };
type Category = { id: number; name: string; kind: "income" | "expense" };
type Party = { id: number; name: string };
type Movement = { amount: number; fund_account: { id: number; display_name: string } | null };
type Transaction = { id: number; type: string; business_date: string; amount: number; economic_effect_sign?:number; correction_of_id?:number|null; status: string; source_type: string; source_key: string | null; source_synced_at: string | null; memo: string | null; category: { name: string } | null; party: { name: string } | null; movements: Movement[]; corrections?:Array<{id:number;business_date:string;amount:number;economic_effect_sign:number;memo:string|null}> };
type LedgerData = { summary: { income: number; expense: number; operatingProfit: number }; accounts: Account[]; categories: Category[]; parties: Party[]; transactions: Transaction[] };
type EntryType = "expense" | "income" | "transfer" | "balance_adjustment";

const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const currentVietnamLocalTime = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 16);
const formatMoney = (value: number) => `${new Intl.NumberFormat("vi-VN").format(value)} ₫`;

export default function LedgerPage() {
  const [month, setMonth] = useState(currentMonth); const [data, setData] = useState<LedgerData | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [formOpen, setFormOpen] = useState(false); const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false); const [syncMessage, setSyncMessage] = useState(""); const [drilldown, setDrilldown] = useState<Record<string, unknown> | null>(null); const [employeeDrilldown,setEmployeeDrilldown]=useState<Record<string,unknown>|null>(null);
  const [closedMonth,setClosedMonth]=useState(false); const [type, setType] = useState<EntryType>("expense"); const [amount, setAmount] = useState(""); const [occurredAt, setOccurredAt] = useState(currentVietnamLocalTime); const [recognitionMonth, setRecognitionMonth] = useState(currentMonth);
  const [categoryId, setCategoryId] = useState(""); const [partyId, setPartyId] = useState(""); const [fromAccountId, setFromAccountId] = useState(""); const [toAccountId, setToAccountId] = useState(""); const [memo, setMemo] = useState(""); const [reason, setReason] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try { const response = await fetch(`/api/admin/ledger?month=${month}`, { cache: "no-store", signal }); const body = await response.json(); if (!response.ok) throw new Error(body.code); setData(body); }
    catch (cause) { if ((cause as Error).name !== "AbortError") setError("장부를 불러오지 못했습니다."); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [month]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  const categories = useMemo(() => data?.categories.filter((category) => category.kind === (type === "income" ? "income" : "expense")) ?? [], [data, type]);
  const selectedCategoryId = categories.some((category) => String(category.id) === categoryId) ? categoryId : String(categories[0]?.id ?? "");
  const accounts = data?.accounts.filter((account) => account.is_active) ?? [];
  const adjustmentIsPositive = !amount.startsWith("-");

  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    const payload = { type, amount: Math.abs(Number(amount)), occurredAt: `${occurredAt}:00+07:00`, recognitionMonth: type === "income" || type === "expense" ? `${recognitionMonth}-01` : null, categoryId: type === "income" || type === "expense" ? Number(selectedCategoryId) : null, partyId: partyId ? Number(partyId) : null, fromAccountId: type === "expense" || type === "transfer" || (type === "balance_adjustment" && !adjustmentIsPositive) ? Number(fromAccountId) : null, toAccountId: type === "income" || type === "transfer" || (type === "balance_adjustment" && adjustmentIsPositive) ? Number(toAccountId) : null, memo, reason };
    try { const response = await fetch("/api/admin/ledger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); const body = await response.json(); if (!response.ok) throw new Error(body.code); setFormOpen(false); setAmount(""); setMemo(""); setReason(""); setPartyId(""); await load(); }
    catch (cause) { setError(`등록 실패: ${(cause as Error).message}`); }
    finally { setSaving(false); }
  }

  async function syncPosSales() {
    setSyncing(true); setError(""); setSyncMessage("");
    try { const response = await fetch("/api/admin/ledger/pos-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ month }) }); const body = await response.json(); if (!response.ok) throw new Error(body.code); setSyncMessage(`POS 동기화: 생성 ${body.createdCount}, 갱신 ${body.updatedCount}, 변경없음 ${body.unchangedCount}, drift ${body.driftCount}`); await load(); }
    catch (cause) { setError(`POS 동기화 실패: ${(cause as Error).message}`); }
    finally { setSyncing(false); }
  }

  async function openPosDrilldown(transactionId: number) {
    setError("");
    try { const response = await fetch(`/api/admin/ledger/transactions/${transactionId}/pos-drilldown`, { cache: "no-store" }); const body = await response.json(); if (!response.ok) throw new Error(body.code); setDrilldown(body.drilldown); }
    catch (cause) { setError(`POS 상세 조회 실패: ${(cause as Error).message}`); }
  }
  async function openEmployeeDrilldown(transactionId:number){setError("");try{const response=await fetch(`/api/admin/ledger/transactions/${transactionId}/employee-cost-drilldown`,{cache:"no-store"});const body=await response.json();if(!response.ok)throw new Error(body.code);setEmployeeDrilldown(body)}catch(cause){setError(`직원 비용 상세 조회 실패: ${(cause as Error).message}`)}}

  return <Container><main style={styles.page}>
    <header style={styles.header}><div><span style={styles.badge}>LEDGER V1</span><h1 style={styles.title}>가게 장부</h1></div><div style={styles.actions}><button type="button" disabled={syncing} style={styles.secondary} onClick={syncPosSales}>{syncing ? "POS 동기화 중..." : "POS 매출 동기화"}</button><button type="button" disabled={closedMonth} style={styles.primary} onClick={() => setFormOpen((value) => !value)}>거래 등록</button></div></header>
    <label style={styles.month}>선택 월<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} style={styles.input} /></label>
    {error ? <p role="alert" style={styles.error}>{error}</p> : null}
    {syncMessage ? <p role="status" style={styles.notice}>{syncMessage}</p> : null}
    {loading ? <p>불러오는 중...</p> : data ? <>
      <MonthClosePanel month={month} onState={setClosedMonth} />
      <section style={styles.summary}><Summary label="월 수입" value={data.summary.income} /><Summary label="월 비용" value={data.summary.expense} /><Summary label="월 영업이익" value={data.summary.operatingProfit} /></section>
      <section><h2 style={styles.heading}>현재 계정별 장부잔액</h2><div style={styles.cards}>{data.accounts.map((account) => <article key={account.id} style={styles.card}><span>{account.display_name}</span><strong>{formatMoney(account.balance)}</strong></article>)}</div></section>
      {formOpen ? <form onSubmit={submit} style={styles.form}>
        <h2 style={styles.heading}>수동 거래 등록</h2>
        <Field label="유형"><select value={type} onChange={(event) => setType(event.target.value as EntryType)} style={styles.input}><option value="expense">즉시 지출</option><option value="income">기타 수입</option><option value="transfer">내부 계정이체</option><option value="balance_adjustment">잔액조정</option></select></Field>
        <Field label={type === "balance_adjustment" ? "금액 (+/-)" : "금액"}><input required inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} style={styles.input} /></Field>
        <Field label="발생/지급일"><input required type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} style={styles.input} /></Field>
        {type === "expense" || type === "income" ? <><Field label="손익 귀속월"><input required type="month" value={recognitionMonth} onChange={(event) => setRecognitionMonth(event.target.value)} style={styles.input} /></Field><Field label="카테고리"><select required value={selectedCategoryId} onChange={(event) => setCategoryId(event.target.value)} style={styles.input}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field></> : null}
        {type === "expense" ? <Field label="거래처 (선택)"><select value={partyId} onChange={(event) => setPartyId(event.target.value)} style={styles.input}><option value="">없음</option>{data.parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}</select></Field> : null}
        {type === "expense" || type === "transfer" || (type === "balance_adjustment" && !adjustmentIsPositive) ? <AccountSelect label="출금/감소 계정" value={fromAccountId} setValue={setFromAccountId} accounts={accounts} /> : null}
        {type === "income" || type === "transfer" || (type === "balance_adjustment" && adjustmentIsPositive) ? <AccountSelect label="입금/증가 계정" value={toAccountId} setValue={setToAccountId} accounts={accounts} /> : null}
        {type === "balance_adjustment" ? <Field label="조정 사유"><input required value={reason} onChange={(event) => setReason(event.target.value)} style={styles.input} /></Field> : null}
        <Field label="메모 (선택)"><input value={memo} onChange={(event) => setMemo(event.target.value)} style={styles.input} /></Field><button disabled={saving} style={styles.primary}>{saving ? "저장 중..." : "저장"}</button>
      </form> : null}
      <InventoryCandidatePanel month={month} />
      <RecurringReserveBepPanel month={month} accounts={data.accounts} onChanged={load} />
      <a href="/admin/ledger/card-settlements" style={styles.secondary}>카드 정산</a>
      <a href="/admin/ledger/payables" style={styles.secondary}>거래처별 미지급 상세 및 지급</a>
      <a href="/admin/ledger/owners" style={styles.secondary}>사장 투자금 및 정산</a>
      <section><h2 style={styles.heading}>최근 거래</h2><div style={styles.list}>{data.transactions.length === 0 ? <p style={styles.card}>등록된 거래가 없습니다.</p> : data.transactions.map((transaction) => { const posAutomatic=transaction.source_type === "pos_sales_daily_payment",employeeAutomatic=["payroll_completed_batch","attendance_meal_daily_candidate"].includes(transaction.source_type); return <article key={transaction.id} style={styles.transaction}><div><strong>{transaction.correction_of_id?"[정정] ":""}{posAutomatic?`[자동] ${posLabel(transaction.source_key)}`:employeeAutomatic?`[자동] ${transaction.source_type==="payroll_completed_batch"?"급여/인건비":"직원 식대"}`:transaction.memo||transaction.party?.name||transactionLabel(transaction.type)}</strong><small>{transaction.business_date} · {transaction.category?.name ?? "손익 제외"}</small><small>{transaction.movements.map((movement) => movement.fund_account?.display_name).filter(Boolean).join(" → ")} · {transaction.status}</small>{transaction.corrections?.map(correction=><small key={correction.id}>{correction.business_date}에 {correction.economic_effect_sign<0?"-":"+"}{formatMoney(correction.amount)} 정정됨</small>)}{posAutomatic?<button type="button" style={styles.detailButton} onClick={()=>openPosDrilldown(transaction.id)}>POS 영수증 상세</button>:employeeAutomatic?<button type="button" style={styles.detailButton} onClick={()=>openEmployeeDrilldown(transaction.id)}>계산 상세</button>:null}</div><b>{transaction.economic_effect_sign===-1?"-":""}{formatMoney(transaction.amount)}</b></article>; })}</div></section>
      {drilldown ? <section style={styles.card}><div style={styles.header}><h2 style={styles.heading}>POS 상세</h2><button type="button" style={styles.detailButton} onClick={() => setDrilldown(null)}>닫기</button></div><p>원본 합계 {formatMoney(Number(drilldown.sourceAmount ?? 0))} · 장부 {formatMoney(Number(drilldown.ledgerAmount ?? 0))}</p><div style={styles.list}>{(drilldown.payments as Array<Record<string, unknown>> ?? []).map((payment, index) => <div key={String(payment.paymentId ?? index)} style={styles.transaction}><span>{String(payment.refNo ?? "-")} · {String(payment.refDate ?? "-")} · {String(payment.paymentMethod ?? "-")}</span><b>{formatMoney(Number(payment.paymentAmount ?? 0))}</b></div>)}</div></section> : null}
      {employeeDrilldown?<section style={styles.card}><div style={styles.header}><h2 style={styles.heading}>직원 비용 상세</h2><button type="button" style={styles.detailButton} onClick={()=>setEmployeeDrilldown(null)}>닫기</button></div><p>장부 금액 {formatMoney(Number(employeeDrilldown.transactionAmount??0))} · parity {employeeDrilldown.parity?"일치":"불일치"}</p><pre style={{whiteSpace:"pre-wrap",fontSize:12}}>{JSON.stringify(employeeDrilldown.source,null,2)}</pre></section>:null}
    </> : null}
  </main></Container>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label style={styles.field}>{label}{children}</label>; }
function Summary({ label, value }: { label: string; value: number }) { return <article style={styles.card}><span>{label}</span><strong>{formatMoney(value)}</strong></article>; }
function AccountSelect({ label, value, setValue, accounts }: { label: string; value: string; setValue: (value: string) => void; accounts: Account[] }) { return <Field label={label}><select required value={value} onChange={(event) => setValue(event.target.value)} style={styles.input}><option value="">선택</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.display_name}</option>)}</select></Field>; }
function transactionLabel(type: string) { return ({ expense: "지출", income: "수입", transfer: "내부이체", balance_adjustment: "잔액조정" } as Record<string, string>)[type] ?? type; }
function posLabel(sourceKey: string | null) { const bucket = sourceKey?.split(":").at(-1); return ({ cash: "POS 현금", transfer: "POS 계좌이체", card: "POS 카드", other: "POS 기타" } as Record<string, string>)[bucket ?? ""] ?? "POS 매출"; }

const styles = { page: { display: "grid", gap: 16, paddingBottom: 24 }, header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }, actions: { display: "flex", gap: 6, flexWrap: "wrap" }, badge: { ...ui.badgeMini, background: "#111827" }, title: { margin: "6px 0 0", fontSize: 24 }, primary: { ...ui.button, width: "auto", padding: "10px 14px" }, secondary: { ...ui.subButton, width: "auto", padding: "10px 12px" }, detailButton: { ...ui.subButton, width: "auto", marginTop: 6, padding: "5px 8px", fontSize: 11 }, month: { display: "grid", gap: 5, fontWeight: 800, maxWidth: 240 }, field: { display: "grid", gap: 5, fontWeight: 800 }, input: { ...ui.input, width: "100%" }, summary: { display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8 }, cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }, card: { ...ui.card, padding: 12, display: "grid", gap: 5 }, heading: { fontSize: 17, margin: "0 0 8px" }, form: { ...ui.card, padding: 14, display: "grid", gap: 10 }, list: { display: "grid", gap: 7 }, transaction: { ...ui.card, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }, error: { color: "#b91c1c", fontWeight: 800 }, notice: { margin: 0, color: "#166534", fontWeight: 800 } } satisfies Record<string, CSSProperties>;
