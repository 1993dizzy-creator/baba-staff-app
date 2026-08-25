"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import Container from "@/components/Container";
import styles from "../ledger-settings.module.css";

type Account = { id: number; code: string; type: string; display_name: string; is_active: boolean };
type Category = { id: number; name: string; kind: "income" | "expense"; cost_behavior?: string; is_active: boolean };
type Party = { id: number; name: string; type?: string; is_active: boolean };
type Recurring = { id: number; name: string; category_id: number; amount: number; recognition_day: number; effective_from: string; effective_to: string | null; party_id: number | null; is_active: boolean; source_key_prefix: string; memo: string | null };
type Reserve = { id: number; name: string; target_amount: number; target_date: string | null; is_active: boolean; memo: string | null; currentAmount: number };
type User = { id: number; name?: string; full_name?: string; username?: string };
type Participant = { id: number; user_id: number; sort_order: number };
type OwnerData = { users: User[]; participants: Participant[]; settings: { tracking_start_month?: string; opening_undistributed_profit?: number } | null; policy: { effective_month: string; revision: number; lines: Array<{ participant_id: number; settlement_rate: string }> } | null };
type LedgerData = { accounts: Account[]; categories: Category[]; parties: Party[] };
const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;
const toRate = (percent: string) => {
  const [whole = "0", fraction = ""] = percent.trim().split(".");
  const million = BigInt(1_000_000);
  const scaled = (BigInt(whole || "0") * million + BigInt((fraction + "000000").slice(0, 6))) / BigInt(100);
  return `${scaled / million}.${String(scaled % million).padStart(6, "0")}`;
};

export default function LedgerSettingsPage() {
  const month = useMemo(currentMonth, []);
  const [ledger, setLedger] = useState<LedgerData | null>(null);
  const [recurring, setRecurring] = useState<Recurring[]>([]);
  const [reserves, setReserves] = useState<Reserve[]>([]);
  const [owners, setOwners] = useState<OwnerData | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [plan, setPlan] = useState({ name: "", categoryId: "", amount: "", recognitionDay: "1", effectiveFrom: month, partyId: "", sourceKeyPrefix: "", memo: "" });
  const [reserve, setReserve] = useState({ name: "", targetAmount: "", targetDate: "", memo: "" });
  const [effectiveMonth, setEffectiveMonth] = useState(month);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [rates, setRates] = useState<Record<number, string>>({});
  const [profit, setProfit] = useState({ trackingMonth: month, openingProfit: "0", reason: "" });

  const load = useCallback(async () => {
    const responses = await Promise.all([
      fetch(`/api/admin/ledger?month=${month}`, { cache: "no-store" }),
      fetch("/api/admin/ledger/recurring-expenses", { cache: "no-store" }),
      fetch("/api/admin/ledger/reserves", { cache: "no-store" }),
      fetch(`/api/admin/ledger/owners?throughMonth=${month}`, { cache: "no-store" }),
    ]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    const failed = responses.findIndex(response => !response.ok);
    if (failed >= 0) throw new Error(bodies[failed]?.code ?? "LOAD_FAILED");
    setLedger(bodies[0]); setRecurring(bodies[1].plans); setReserves(bodies[2].plans); setOwners(bodies[3]);
    setSelectedUsers((bodies[3].participants as Participant[]).map(row => String(row.user_id)));
    setRates(Object.fromEntries((bodies[3].policy?.lines ?? []).map((line: { participant_id: number; settlement_rate: string }) => [line.participant_id, String(Number(line.settlement_rate) * 100)])));
  }, [month]);
  useEffect(() => { void load().catch(cause => setError(`설정을 불러오지 못했습니다: ${(cause as Error).message}`)); }, [load]);

  async function mutate(url: string, body: Record<string, unknown>, method = "POST") {
    setWorking(true); setError(""); setMessage("");
    try { const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.code); setMessage("설정을 저장했습니다."); await load(); }
    catch (cause) { setError(`저장하지 못했습니다: ${(cause as Error).message}`); }
    finally { setWorking(false); }
  }
  async function createPlan(event: FormEvent) { event.preventDefault(); await mutate("/api/admin/ledger/recurring-expenses", { name: plan.name, categoryId: Number(plan.categoryId), amount: Number(plan.amount), recognitionDay: Number(plan.recognitionDay), effectiveFrom: `${plan.effectiveFrom}-01`, partyId: plan.partyId ? Number(plan.partyId) : null, sourceKeyPrefix: plan.sourceKeyPrefix, memo: plan.memo }); }
  async function createReserve(event: FormEvent) { event.preventDefault(); await mutate("/api/admin/ledger/reserves", { name: reserve.name, targetAmount: Number(reserve.targetAmount), targetDate: reserve.targetDate || null, linkedRecurringPlanId: null, memo: reserve.memo }); setReserve({ name: "", targetAmount: "", targetDate: "", memo: "" }); }

  const expenseCategories = ledger?.categories.filter(row => row.kind === "expense") ?? [];
  return <Container><main className={styles.page}>
    <header className={styles.settingsIntro}><p className={styles.eyebrow}>가게 장부</p><h1>장부설정</h1><p className={styles.sectionDescription}>장부작성에 사용할 기준 정보와 계획을 관리합니다.</p></header>
    {message ? <p role="status" className={styles.notice}>{message}</p> : null}{error ? <p role="alert" className={styles.error}>{error}</p> : null}
    <div className={styles.settingsGrid}>
      <details className={styles.settingsSection} open><summary>자금계정</summary><p className={styles.sectionDescription}>장부에서 사용하는 현금·계좌 등 자금 위치입니다. 현재 API는 조회만 지원합니다.</p><div className={styles.dataList}>{ledger?.accounts.map(row => <div className={styles.dataRow} key={row.id}><strong>{row.display_name}</strong><span>{row.type} · {row.is_active ? "사용 중" : "사용 안 함"}</span></div>)}</div></details>
      <details className={styles.settingsSection} open><summary>수입·비용 분류</summary><p className={styles.sectionDescription}>장부작성에서 사용할 카테고리입니다. 현재 API는 조회만 지원합니다.</p><div className={styles.chips}>{ledger?.categories.map(row => <span className={styles.chip} key={row.id}>{row.kind === "income" ? "수입" : "비용"} · {row.name}</span>)}</div></details>
      <details className={styles.settingsSection}><summary>거래처</summary><p className={styles.sectionDescription}>거래처 정보가 Ledger 호환 데이터로 자동 연결됩니다. 거래처를 별도로 만들 필요가 없습니다.</p><div className={styles.chips}>{ledger?.parties.map(row => <span className={styles.chip} key={row.id}>{row.name}</span>)}</div><Link className={styles.secondary} href="/admin/partners/info">거래처 관리로 이동</Link></details>
      <details className={styles.settingsSection}><summary>반복비용</summary><p className={styles.sectionDescription}>월세 등 반복되는 고정비 기준을 관리합니다. 실제 지급은 장부작성에서 처리합니다.</p><div className={styles.dataList}>{recurring.map(row => <div className={styles.dataRow} key={row.id}><strong>{row.name}<br />{money(Number(row.amount))}</strong><span>{row.effective_from} ~ {row.effective_to ?? "계속"}<br />{row.is_active ? "사용 중" : "사용 안 함"}</span></div>)}</div><form className={styles.form} onSubmit={createPlan}><label>반복비용명<input required className={styles.input} value={plan.name} onChange={event => setPlan({ ...plan, name: event.target.value })} /></label><label>비용 카테고리<select required className={styles.input} value={plan.categoryId} onChange={event => setPlan({ ...plan, categoryId: event.target.value })}><option value="">선택</option>{expenseCategories.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>월 금액<input required type="number" min="0.001" step="0.001" className={styles.input} value={plan.amount} onChange={event => setPlan({ ...plan, amount: event.target.value })} /></label><label>매월 인식일<input required type="number" min="1" max="31" className={styles.input} value={plan.recognitionDay} onChange={event => setPlan({ ...plan, recognitionDay: event.target.value })} /></label><label>적용 시작월<input required type="month" className={styles.input} value={plan.effectiveFrom} onChange={event => setPlan({ ...plan, effectiveFrom: event.target.value })} /></label><label>거래처<select className={styles.input} value={plan.partyId} onChange={event => setPlan({ ...plan, partyId: event.target.value })}><option value="">설정 안 함</option>{ledger?.parties.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>반복 항목 코드<input required className={styles.input} placeholder="예: rent" value={plan.sourceKeyPrefix} onChange={event => setPlan({ ...plan, sourceKeyPrefix: event.target.value })} /></label><label>메모<input className={styles.input} value={plan.memo} onChange={event => setPlan({ ...plan, memo: event.target.value })} /></label><button className={styles.primary} disabled={working}>반복비용 추가</button></form></details>
      <details className={styles.settingsSection}><summary>준비금</summary><p className={styles.sectionDescription}>준비금 목표와 계획을 관리합니다. 적립·해제·사용은 장부작성에서 처리합니다.</p><div className={styles.dataList}>{reserves.map(row => <ReserveRow key={row.id} row={row} working={working} save={(targetAmount, targetDate, memo) => mutate(`/api/admin/ledger/reserves/${row.id}`, { targetAmount, targetDate, memo }, "PATCH")} />)}</div><form className={styles.form} onSubmit={createReserve}><label>준비금 이름<input required className={styles.input} value={reserve.name} onChange={event => setReserve({ ...reserve, name: event.target.value })} /></label><label>목표 금액<input required type="number" min="0.001" step="0.001" className={styles.input} value={reserve.targetAmount} onChange={event => setReserve({ ...reserve, targetAmount: event.target.value })} /></label><label>목표일<input type="date" className={styles.input} value={reserve.targetDate} onChange={event => setReserve({ ...reserve, targetDate: event.target.value })} /></label><label>메모<input className={styles.input} value={reserve.memo} onChange={event => setReserve({ ...reserve, memo: event.target.value })} /></label><button className={styles.primary} disabled={working}>준비금 계획 추가</button></form></details>
      <details className={`${styles.settingsSection} ${styles.fullWidth}`}><summary>사장 정산 기준</summary><p className={styles.sectionDescription}>정산 참여자, 비율과 미분배이익 시작 기준만 관리합니다. 투자와 실제 정산은 장부작성에서 처리합니다.</p>{owners ? <><label className={styles.monthLabel}>적용 월<input className={styles.input} type="month" value={effectiveMonth} onChange={event => setEffectiveMonth(event.target.value)} /></label><div className={styles.checkList}>{owners.users.map(user => <label className={styles.checkLabel} key={user.id}><input type="checkbox" checked={selectedUsers.includes(String(user.id))} onChange={event => setSelectedUsers(event.target.checked ? [...selectedUsers, String(user.id)] : selectedUsers.filter(id => id !== String(user.id)))} />{user.name ?? user.full_name ?? user.username ?? `사용자 #${user.id}`}</label>)}</div><button className={styles.primary} disabled={working || selectedUsers.length !== 3} onClick={() => void mutate("/api/admin/ledger/owners", { action: "participants", effectiveMonth: `${effectiveMonth}-01`, rows: selectedUsers.map((userId, index) => ({ userId: Number(userId), isEligible: true, sortOrder: index + 1 })) })}>참여자 3명 저장</button><div className={styles.form}>{owners.participants.map(row => <label key={row.id}>참여자 #{row.id} 비율(%)<input className={styles.input} inputMode="decimal" value={rates[row.id] ?? ""} onChange={event => setRates({ ...rates, [row.id]: event.target.value })} /></label>)}<button className={styles.primary} disabled={working || owners.participants.length === 0} onClick={() => void mutate("/api/admin/ledger/owners", { action: "policy", effectiveMonth: `${effectiveMonth}-01`, lines: owners.participants.map(row => ({ participantId: row.id, rate: toRate(rates[row.id] ?? "0") })), note: "Owner settlement policy" })}>정산 비율 저장</button></div>{owners.settings ? <div className={styles.notice}>미분배이익 tracking 시작월 {owners.settings.tracking_start_month ?? "설정됨"} · Opening {money(Number(owners.settings.opening_undistributed_profit ?? 0))}</div> : <div className={styles.form}><label>미분배이익 시작월<input className={styles.input} type="month" value={profit.trackingMonth} onChange={event => setProfit({ ...profit, trackingMonth: event.target.value })} /></label><label>Opening undistributed profit<input className={styles.input} inputMode="decimal" value={profit.openingProfit} onChange={event => setProfit({ ...profit, openingProfit: event.target.value })} /></label><label>설정 사유<input className={styles.input} value={profit.reason} onChange={event => setProfit({ ...profit, reason: event.target.value })} /></label><button className={styles.primary} disabled={working} onClick={() => void mutate("/api/admin/ledger/owners", { action: "profit_settings", trackingStartMonth: `${profit.trackingMonth}-01`, openingProfit: profit.openingProfit, reason: profit.reason })}>시작 기준 저장</button></div>}</> : null}</details>
    </div>
  </main></Container>;
}

function ReserveRow({ row, working, save }: { row: Reserve; working: boolean; save: (amount: number, date: string | null, memo: string) => Promise<void> }) { const [amount, setAmount] = useState(String(row.target_amount)); const [date, setDate] = useState(row.target_date ?? ""); const [memo, setMemo] = useState(row.memo ?? ""); return <div className={styles.form}><strong>{row.name} · 현재 {money(row.currentAmount)}</strong><label>목표 금액<input className={styles.input} type="number" step="0.001" value={amount} onChange={event => setAmount(event.target.value)} /></label><label>목표일<input className={styles.input} type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label>메모<input className={styles.input} value={memo} onChange={event => setMemo(event.target.value)} /></label><button className={styles.secondary} disabled={working} onClick={() => void save(Number(amount), date || null, memo)}>목표 수정</button></div>; }
