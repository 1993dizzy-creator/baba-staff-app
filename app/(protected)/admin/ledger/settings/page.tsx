"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import Container from "@/components/Container";
import styles from "../ledger-settings.module.css";

type Account = { id: number; code: string; type: string; display_name: string; is_active: boolean };
type Category = { id: number; name: string; kind: "income" | "expense"; parent_id: number | null; cost_behavior?: string; is_active: boolean };
type Party = { id: number; name: string; type?: string; is_active: boolean };
type Recurring = { id: number; name: string; category_id: number; amount: number; recognition_day: number; effective_from: string; effective_to: string | null; party_id: number | null; is_active: boolean; source_key_prefix: string; memo: string | null };
type ReserveEntry = { id: number; entry_type: string; amount: number | string; occurred_at: string; memo: string | null };
type ReserveFundAccount = { id: number; code: string; displayName: string };
type ReserveRecurring = { monthlyAmount: number; recurringDay: number; startMonth: string; endMonth: string | null; autoGenerate: boolean };
type ReserveSchedule = { id: number; scheduledMonth: string; scheduledDate: string; plannedAmount: number; status: string; skipReason: string | null; reserveEntryId: number | null; resolvedAt: string | null };
type Reserve = { id: number; name: string; target_amount: number; target_date: string | null; is_active: boolean; memo: string | null; fund_account_id: number | null; fundAccount: ReserveFundAccount | null; currentAmount: number; remainingAmount: number; entries: ReserveEntry[] | null; recurring: ReserveRecurring | null; pendingSchedule: ReserveSchedule | null; recentSchedules: ReserveSchedule[] | null; targetReached: boolean };
type EligibleAccount = { id: number; code: string; displayName: string; type: string };
type User = { id: number; name?: string; full_name?: string; username?: string };
type Participant = { id: number; user_id: number; sort_order: number };
type OwnerData = { users: User[]; participants: Participant[]; settings: { tracking_start_month?: string; opening_undistributed_profit?: number } | null; policy: { effective_month: string; revision: number; lines: Array<{ participant_id: number; settlement_rate: string }> } | null };
type LedgerData = { accounts: Account[]; categories: Category[]; parties: Party[] };
type SettingsTab = "basic" | "automation" | "owners";
const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;
const localDateTime = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 16);
const RESERVE_ENTRY_LABELS: Record<string, string> = { allocate: "적립", release: "해제", consume: "사용", adjustment: "조정" };
const RESERVE_ENTRY_DESCRIPTIONS: Record<string, string> = {
  allocate: "준비금으로 금액을 확보합니다.",
  release: "묶어둔 준비금을 다시 사용 가능 상태로 돌립니다.",
  consume: "준비금 사용 기록이며 실제 장부 지출을 생성하는 기능이 아니며, 실제 비용 지급은 기존 장부 거래 흐름에서 별도 처리합니다.",
  adjustment: "관리상 필요한 준비금 보정 기록입니다.",
};
const RESERVE_SCHEDULE_STATUS_LABELS: Record<string, string> = { pending: "확정 대기", confirmed: "확정됨", skipped: "건너뜀", superseded: "대체됨" };
const formatReserveDateTime = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const monthLabel = (value: string) => value.slice(0, 7);
const formatNumericInput = (value: string) => {
  if (!value) return "";
  const [integer = "", fraction] = value.split(".");
  const grouped = integer ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(integer)) : "";
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
};
const normalizeNumericInput = (value: string) => {
  const cleaned = value.replaceAll(",", "").replace(/[^\d.]/g, "");
  const [integer = "", ...fractions] = cleaned.split(".");
  return fractions.length ? `${integer}.${fractions.join("")}` : integer;
};
const ACCOUNT_UI: Record<string, { order: number; name?: string; short: string; emoji: string }> = {
  store_cash: { order: 0, short: "현금", emoji: "💵" },
  baba_corporate_bank: { order: 1, short: "법인", emoji: "🏦" },
  vuong_personal_custody: { order: 2, name: "개인(Vương)", short: "Vương", emoji: "👤" },
  cho_personal_custody: { order: 3, name: "개인(Cho)", short: "Cho", emoji: "👤" },
  card_clearing: { order: 4, name: "카드결제", short: "카드", emoji: "💳" },
};
const EXPENSE_ROOT_ORDER = new Map([
  ["공과금", 0],
  ["매입비", 1],
  ["인건비", 2],
  ["일반관리비", 3],
  ["임차·시설비", 4],
]);
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
  const [eligibleAccounts, setEligibleAccounts] = useState<EligibleAccount[]>([]);
  const [owners, setOwners] = useState<OwnerData | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("basic");
  const [openExpenseRootId, setOpenExpenseRootId] = useState<number | null>(null);
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<number>>(() => new Set());
  const [planFormOpen, setPlanFormOpen] = useState(false);
  const [reserveFormOpen, setReserveFormOpen] = useState(false);
  const [plan, setPlan] = useState({ name: "", categoryId: "", amount: "", recognitionDay: "1", effectiveFrom: month, partyId: "", sourceKeyPrefix: "", memo: "" });
  const [reserve, setReserve] = useState({ name: "", targetAmount: "", targetDate: "", fundAccountId: "", memo: "" });
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
    setLedger(bodies[0]); setRecurring(bodies[1].plans); setReserves(bodies[2].plans); setEligibleAccounts(bodies[2].eligibleAccounts ?? []); setOwners(bodies[3]);
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
  // Creating a plan only records a target and (optionally) where the money will be kept.
  // It never books an allocate entry — actual reserved money grows only via the entry controls below.
  async function createReserve(event: FormEvent) { event.preventDefault(); await mutate("/api/admin/ledger/reserves", { name: reserve.name, targetAmount: Number(reserve.targetAmount), targetDate: reserve.targetDate || null, linkedRecurringPlanId: null, fundAccountId: reserve.fundAccountId ? Number(reserve.fundAccountId) : null, memo: reserve.memo }); setReserve({ name: "", targetAmount: "", targetDate: "", fundAccountId: "", memo: "" }); }
  async function saveReservePlan(id: number, body: Record<string, unknown>) { await mutate(`/api/admin/ledger/reserves/${id}`, body, "PATCH"); }
  async function addReserveEntry(id: number, body: Record<string, unknown>) { await mutate(`/api/admin/ledger/reserves/${id}/entries`, body); }
  async function saveReserveRecurring(id: number, body: Record<string, unknown>) { await mutate(`/api/admin/ledger/reserves/${id}/recurring`, body, "PUT"); }
  async function generateReserveSchedule() { await mutate("/api/admin/ledger/reserves/schedule", { month }); }
  async function resolveReserveSchedule(scheduleId: number, body: Record<string, unknown>) { await mutate(`/api/admin/ledger/reserves/schedule/${scheduleId}`, body); }

  const expenseCategories = ledger?.categories.filter(row => row.kind === "expense") ?? [];
  const incomeCategories = ledger?.categories.filter(row => row.kind === "income") ?? [];
  const expenseChildren = new Map<number | null, Category[]>();
  for (const category of expenseCategories) {
    const siblings = expenseChildren.get(category.parent_id) ?? [];
    siblings.push(category);
    expenseChildren.set(category.parent_id, siblings);
  }
  for (const siblings of expenseChildren.values()) siblings.sort((left, right) => left.name.localeCompare(right.name, "ko"));
  const expenseRoots = [...(expenseChildren.get(null) ?? [])].sort((left, right) =>
    (EXPENSE_ROOT_ORDER.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (EXPENSE_ROOT_ORDER.get(right.name) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name, "ko"),
  );
  const activeAccountCount = ledger?.accounts.filter(row => row.is_active).length ?? 0;
  const inactiveAccountCount = (ledger?.accounts.length ?? 0) - activeAccountCount;
  const displayedAccounts = [...(ledger?.accounts ?? [])].sort((left, right) => (ACCOUNT_UI[left.code]?.order ?? 999) - (ACCOUNT_UI[right.code]?.order ?? 999));
  const ownerUserName = (userId: number) => {
    const user = owners?.users.find(item => item.id === userId);
    return user?.name ?? user?.full_name ?? user?.username ?? `사용자 #${userId}`;
  };
  const ownerRateTotal = owners?.participants.reduce((total, participant) => total + (Number(rates[participant.id]) || 0), 0) ?? 0;
  function toggleCategory(id: number) {
    setExpandedCategoryIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleExpenseRoot(id: number) {
    setOpenExpenseRootId(current => current === id ? null : id);
  }
  return <Container noPaddingTop><main className={styles.page}>
    <div className={styles.tabs} role="tablist" aria-label="장부설정 유형">
      {([[
        "basic", "기본 설정"], ["automation", "계획 · 자동화"], ["owners", "사장 정산"]] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={activeTab === value} className={activeTab === value ? styles.activeTab : styles.tab} onClick={() => setActiveTab(value)}>{label}</button>)}
    </div>
    {message ? <p role="status" className={styles.notice}>{message}</p> : null}{error ? <p role="alert" className={styles.error}>{error}</p> : null}

    {activeTab === "basic" ? <section className={styles.sectionStack} role="tabpanel">
      <section className={styles.card}><div className={styles.cardHeader}><div><h2>자금계정</h2></div><span className={styles.countBadge}>{inactiveAccountCount === 0 ? `활성 계정 ${activeAccountCount}개` : `활성 ${activeAccountCount} · 비활성 ${inactiveAccountCount}`}</span></div><div className={styles.accountGrid}>{displayedAccounts.map(row => { const accountUi = ACCOUNT_UI[row.code]; return <div className={styles.accountCard} key={row.id}><div><strong><span aria-hidden>{accountUi?.emoji ?? "💰"}</span>{accountUi?.name ?? row.display_name}</strong><span>{accountUi?.short ?? row.display_name}</span></div>{!row.is_active ? <span className={styles.statusInactive}>사용 안 함</span> : null}</div>; })}</div></section>
      <section className={styles.card}><div className={styles.cardHeader}><div><h2>수입·비용 분류</h2></div></div><div className={styles.categoryGrid}><div className={styles.categoryGroup}><strong className={styles.incomeTitle}>수입</strong><div className={styles.chips}>{incomeCategories.map(row => <span className={`${styles.chip} ${styles.incomeChip}`} key={row.id}>{row.name}</span>)}</div></div><div className={`${styles.categoryGroup} ${styles.expenseGroup}`}><strong className={styles.expenseTitle}>비용</strong><div className={styles.expenseTree}>{expenseRoots.map(category => <ExpenseCategoryBranch key={category.id} category={category} childrenByParent={expenseChildren} openRootId={openExpenseRootId} expandedIds={expandedCategoryIds} onToggleRoot={toggleExpenseRoot} onToggleBranch={toggleCategory} />)}</div></div></div></section>
      <section className={styles.card}><div className={styles.cardHeader}><div><h2>거래처</h2></div><span className={styles.connectedBadge}>연결됨</span></div><div className={styles.partnerBody}><strong>{ledger?.parties.length ?? 0}개 거래처</strong><span>거래처 추가·수정은 거래처 관리에서 처리합니다.</span></div><Link className={styles.secondarySmall} href="/admin/partners/info">거래처 관리로 이동 ›</Link></section>
    </section> : null}

    {activeTab === "automation" ? <section className={styles.sectionStack} role="tabpanel">
      <section className={styles.card}><div className={styles.cardHeader}><div><h2>반복비용</h2></div><span className={styles.countBadge}>{recurring.length}개</span></div><div className={styles.recurringList}>{recurring.length ? recurring.map(row => <div className={styles.recurringRow} key={row.id}><div className={styles.recurringHead}><strong>{row.name}</strong><span className={row.is_active ? styles.statusActive : styles.statusInactive}>{row.is_active ? "사용 중" : "사용 안 함"}</span></div><div className={styles.recurringSummary}><div className={styles.recurringAmount}><strong>{money(Number(row.amount))}</strong><span>월 금액</span></div><div><strong>매월 {row.recognition_day}일</strong><span>인식일</span></div><div><strong>{monthLabel(row.effective_from)} ~ {row.effective_to ? monthLabel(row.effective_to) : "계속"}</strong><span>적용기간</span></div></div></div>) : <p className={styles.empty}>설정된 반복비용이 없습니다.</p>}</div><div className={styles.recurringCreate}><button type="button" className={styles.secondarySmall} aria-expanded={planFormOpen} onClick={() => setPlanFormOpen(value => !value)}>{planFormOpen ? "추가 닫기" : "반복비용 추가"}</button>{planFormOpen ? <form className={styles.recurringForm} onSubmit={createPlan}><label className={styles.fullField}>📝 반복비용명<input required className={styles.input} value={plan.name} onChange={event => setPlan({ ...plan, name: event.target.value })} /></label><label className={styles.fullField}>🗂️ 비용 분류<select required className={styles.input} value={plan.categoryId} onChange={event => setPlan({ ...plan, categoryId: event.target.value })}><option value="">선택</option>{expenseRoots.map(root => <optgroup key={root.id} label={`${root.name} · ${countLeafCategories(root.id, expenseChildren)}종`}>{categoryOptionsForRoot(root, expenseChildren).map(({ category, label }) => <option key={category.id} value={category.id}>{label}</option>)}</optgroup>)}</select></label><label>💰 월 금액<input required type="number" inputMode="decimal" min="0.001" step="0.001" className={styles.input} value={plan.amount} onChange={event => setPlan({ ...plan, amount: event.target.value })} /></label><label>📅 매월 인식일<input required type="number" min="1" max="31" className={styles.input} value={plan.recognitionDay} onChange={event => setPlan({ ...plan, recognitionDay: event.target.value })} /></label><label>🗓️ 시작월<input required type="month" className={styles.input} value={plan.effectiveFrom} onChange={event => setPlan({ ...plan, effectiveFrom: event.target.value })} /></label><label>🤝 거래처<select className={styles.input} value={plan.partyId} onChange={event => setPlan({ ...plan, partyId: event.target.value })}><option value="">설정 안 함</option>{ledger?.parties.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>🏷️ 식별 코드<input required className={styles.input} placeholder="예: rent" value={plan.sourceKeyPrefix} onChange={event => setPlan({ ...plan, sourceKeyPrefix: event.target.value })} /></label><label>🗒️ 메모<input className={styles.input} value={plan.memo} onChange={event => setPlan({ ...plan, memo: event.target.value })} /></label><button className={`${styles.primary} ${styles.fullField}`} disabled={working}>반복비용 추가</button></form> : null}</div></section>
      <section className={styles.card}><div className={styles.cardHeader}><div><h2>준비금</h2></div><button type="button" className={`${styles.secondarySmall} ${styles.reserveAddButton}`} aria-expanded={reserveFormOpen} onClick={() => setReserveFormOpen(value => !value)}>{reserveFormOpen ? "추가 닫기" : "+ 준비금 추가"}</button></div><div className={`${styles.infoPanel} ${styles.compactInfo}`}>ℹ️ 준비금은 실제 계좌 잔액이나 장부 비용을 변경하지 않습니다. 실제 지급은 장부작성에서 별도로 기록합니다.</div>{reserveFormOpen ? <form className={styles.formGrid} onSubmit={createReserve}><label>준비금 이름<input required className={styles.input} value={reserve.name} onChange={event => setReserve({ ...reserve, name: event.target.value })} /></label><label>목표 금액<input required type="number" min="0.001" step="0.001" className={styles.input} value={reserve.targetAmount} onChange={event => setReserve({ ...reserve, targetAmount: event.target.value })} /></label><label>목표일<input type="date" className={styles.input} value={reserve.targetDate} onChange={event => setReserve({ ...reserve, targetDate: event.target.value })} /></label><label>연결 계좌<select className={styles.input} value={reserve.fundAccountId} onChange={event => setReserve({ ...reserve, fundAccountId: event.target.value })}><option value="">미연결</option>{eligibleAccounts.map(account => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label><label className={styles.spanTwo}>메모<input className={styles.input} value={reserve.memo} onChange={event => setReserve({ ...reserve, memo: event.target.value })} /></label><p className={`${styles.infoPanel} ${styles.spanTwo}`}>계획을 추가하거나 계좌를 연결해도 목표 금액이 자동으로 적립되지 않습니다. 실제 확보 금액은 적립 기록 또는 pending 확정으로만 늘어납니다.</p><button className={styles.primary} disabled={working}>준비금 계획 추가</button></form> : null}<div className={styles.reserveList}>{reserves.map(row => <ReservePlanCard key={row.id} row={row} month={month} eligibleAccounts={eligibleAccounts} working={working} savePlan={saveReservePlan} addEntry={addReserveEntry} saveRecurring={saveReserveRecurring} generateSchedule={generateReserveSchedule} resolveSchedule={resolveReserveSchedule} />)}</div></section>
    </section> : null}

    {activeTab === "owners" ? <section className={styles.sectionStack} role="tabpanel"><section className={`${styles.card} ${styles.ownerCard}`}><div className={styles.cardHeader}><div><h2>사장 정산 기준</h2><p>참여자·정산 비율·미분배이익 기준을 관리합니다.</p></div></div>{owners ? <><div className={styles.ownerSummary}><div><span>📅 적용 월</span><strong>{effectiveMonth}</strong></div><div><span>👥 정산 참여자</span><strong>{owners.participants.length}명</strong></div><div><span>⚖️ 정산 비율</span><strong>{owners.policy ? "설정됨" : "미설정"}</strong></div><div><span>💰 미분배이익 기준</span><strong>{owners.settings ? "설정됨" : "미설정"}</strong></div></div><details name="owner-settings" className={styles.detailPanel}><summary>정산 참여자 수정</summary><div className={styles.detailBody}><div className={styles.participantSummary}><label><span>📅 적용 월</span><input className={styles.input} type="month" value={effectiveMonth} onChange={event => setEffectiveMonth(event.target.value)} /></label><div><span>선택 인원</span><strong>{selectedUsers.length} / 3명</strong></div></div><div className={styles.ownerChoiceGrid}>{owners.users.map(user => { const selected = selectedUsers.includes(String(user.id)); return <label className={`${styles.ownerChoice} ${selected ? styles.ownerChoiceActive : ""}`} key={user.id}><input type="checkbox" checked={selected} onChange={event => setSelectedUsers(event.target.checked ? [...selectedUsers, String(user.id)] : selectedUsers.filter(id => id !== String(user.id)))} /><span>{user.name ?? user.full_name ?? user.username ?? `사용자 #${user.id}`}</span></label>; })}</div><button className={`${styles.primary} ${styles.ownerAction}`} disabled={working || selectedUsers.length !== 3} onClick={() => void mutate("/api/admin/ledger/owners", { action: "participants", effectiveMonth: `${effectiveMonth}-01`, rows: selectedUsers.map((userId, index) => ({ userId: Number(userId), isEligible: true, sortOrder: index + 1 })) })}>참여자 저장</button></div></details><details name="owner-settings" className={styles.detailPanel}><summary>정산 비율 수정</summary><div className={styles.detailBody}>{owners.participants.length === 0 ? <p className={styles.compactEmpty}>먼저 정산 참여자 3명을 설정해주세요.</p> : <><div className={styles.ownerRateList}>{owners.participants.map(row => <label className={styles.ownerRateRow} key={row.id}><span>{ownerUserName(row.user_id)}</span><span className={styles.rateInput}><input className={styles.input} inputMode="decimal" value={rates[row.id] ?? ""} onChange={event => setRates({ ...rates, [row.id]: event.target.value })} /><span>%</span></span></label>)}</div><div className={styles.rateTotal}><span>정산 비율 합계</span><strong>{new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 4 }).format(ownerRateTotal)}%</strong></div><button className={`${styles.primary} ${styles.ownerAction}`} disabled={working || owners.participants.length === 0} onClick={() => void mutate("/api/admin/ledger/owners", { action: "policy", effectiveMonth: `${effectiveMonth}-01`, lines: owners.participants.map(row => ({ participantId: row.id, rate: toRate(rates[row.id] ?? "0") })), note: "Owner settlement policy" })}>정산 비율 저장</button></>}</div></details><details name="owner-settings" className={styles.detailPanel}><summary>미분배이익 시작 기준</summary><div className={styles.detailBody}>{owners.settings ? <div className={styles.infoPanel}>시작월 {owners.settings.tracking_start_month ?? "설정됨"} · 시작 미분배이익 {money(Number(owners.settings.opening_undistributed_profit ?? 0))}</div> : <><p className={styles.sectionDescription}>장부 추적을 시작하기 전 누적된 미분배이익을 입력합니다.</p><div className={styles.profitGrid}><label>📅 시작월<input className={styles.input} type="month" value={profit.trackingMonth} onChange={event => setProfit({ ...profit, trackingMonth: event.target.value })} /></label><label>💰 시작 미분배이익<input className={styles.input} type="text" inputMode="decimal" value={formatNumericInput(profit.openingProfit)} onChange={event => setProfit({ ...profit, openingProfit: normalizeNumericInput(event.target.value) })} /></label><label className={styles.profitReason}>🗒️ 설정 사유<input className={styles.input} value={profit.reason} onChange={event => setProfit({ ...profit, reason: event.target.value })} /></label></div><button className={`${styles.primary} ${styles.ownerAction}`} disabled={working} onClick={() => void mutate("/api/admin/ledger/owners", { action: "profit_settings", trackingStartMonth: `${profit.trackingMonth}-01`, openingProfit: profit.openingProfit, reason: profit.reason })}>미분배이익 기준 저장</button></>}</div></details></> : null}</section></section> : null}
  </main></Container>;
}

function countLeafCategories(categoryId: number, childrenByParent: Map<number | null, Category[]>, ancestors = new Set<number>()): number {
  if (ancestors.has(categoryId)) return 0;
  const children = childrenByParent.get(categoryId) ?? [];
  if (children.length === 0) return 1;
  const nextAncestors = new Set(ancestors).add(categoryId);
  return children.reduce((total, child) => total + countLeafCategories(child.id, childrenByParent, nextAncestors), 0);
}

function categoryOptionsForRoot(root: Category, childrenByParent: Map<number | null, Category[]>) {
  const options: Array<{ category: Category; label: string }> = [{ category: root, label: root.name }];
  const visited = new Set<number>([root.id]);
  function visit(category: Category, path: string[]) {
    if (visited.has(category.id)) return;
    visited.add(category.id);
    const nextPath = [...path, category.name];
    options.push({ category, label: nextPath.join(" › ") });
    for (const child of childrenByParent.get(category.id) ?? []) visit(child, nextPath);
  }
  for (const child of childrenByParent.get(root.id) ?? []) visit(child, []);
  return options;
}

function ExpenseCategoryBranch({ category, childrenByParent, openRootId, expandedIds, onToggleRoot, onToggleBranch, depth = 0 }: {
  category: Category;
  childrenByParent: Map<number | null, Category[]>;
  openRootId: number | null;
  expandedIds: Set<number>;
  onToggleRoot: (id: number) => void;
  onToggleBranch: (id: number) => void;
  depth?: number;
}) {
  const children = childrenByParent.get(category.id) ?? [];
  if (children.length === 0) return <span className={`${styles.chip} ${styles.expenseChip}`}>{category.name}</span>;
  const isRoot = depth === 0;
  const open = isRoot ? openRootId === category.id : expandedIds.has(category.id);
  return <div className={depth === 0 ? styles.expenseRoot : styles.expenseBranch}>
    <button type="button" className={styles.expenseToggle} aria-expanded={open} onClick={() => isRoot ? onToggleRoot(category.id) : onToggleBranch(category.id)}><span>{category.name}</span><span className={styles.expenseCount}>{countLeafCategories(category.id, childrenByParent)}종</span><span className={styles.chevron} aria-hidden>{open ? "⌃" : "›"}</span></button>
    {open ? <div className={styles.expenseChildren}>{children.map(child => <ExpenseCategoryBranch key={child.id} category={child} childrenByParent={childrenByParent} openRootId={openRootId} expandedIds={expandedIds} onToggleRoot={onToggleRoot} onToggleBranch={onToggleBranch} depth={depth + 1} />)}</div> : null}
  </div>;
}

function ReservePlanCard({ row, month, eligibleAccounts, working, savePlan, addEntry, saveRecurring, generateSchedule, resolveSchedule }: {
  row: Reserve;
  month: string;
  eligibleAccounts: EligibleAccount[];
  working: boolean;
  savePlan: (id: number, body: Record<string, unknown>) => Promise<void>;
  addEntry: (id: number, body: Record<string, unknown>) => Promise<void>;
  saveRecurring: (id: number, body: Record<string, unknown>) => Promise<void>;
  generateSchedule: () => Promise<void>;
  resolveSchedule: (scheduleId: number, body: Record<string, unknown>) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(row.target_amount));
  const [date, setDate] = useState(row.target_date ?? "");
  const [memo, setMemo] = useState(row.memo ?? "");
  const [account, setAccount] = useState(row.fund_account_id ? String(row.fund_account_id) : "");
  const [entryType, setEntryType] = useState("allocate");
  const [entryAmount, setEntryAmount] = useState("");
  const [entryMemo, setEntryMemo] = useState("");
  const [occurredAt, setOccurredAt] = useState(localDateTime);
  const [recMonthly, setRecMonthly] = useState(row.recurring ? String(row.recurring.monthlyAmount) : "");
  const [recDay, setRecDay] = useState(row.recurring ? String(row.recurring.recurringDay) : "1");
  const [recStart, setRecStart] = useState(row.recurring ? monthLabel(row.recurring.startMonth) : month);
  const [recEnd, setRecEnd] = useState(row.recurring?.endMonth ? monthLabel(row.recurring.endMonth) : "");
  const [recAuto, setRecAuto] = useState(row.recurring?.autoGenerate ?? false);
  const [openSection, setOpenSection] = useState<"plan" | "recurring" | "entry" | "history" | null>(null);
  const entries = row.entries ?? [];
  const recentSchedules = row.recentSchedules ?? [];
  const pending = row.pendingSchedule;
  // ledger_reserve_plans_fund_account_guard blocks a fund-account change on a non-empty plan.
  const accountLocked = row.currentAmount !== 0;
  return (
    <article className={styles.reserveCard}>
      <header className={styles.reserveHeader}><div><span className={styles.overline}>준비금 계획</span><h3>{row.name}</h3><div className={styles.reserveMeta}><span>🏦 {row.fundAccount?.displayName ?? "연결 계좌 미설정"}</span><span className={row.recurring ? styles.statusActive : styles.statusInactive}>{row.recurring ? "정기 적립 설정됨" : "정기 적립 미설정"}</span></div></div></header>
      <div className={styles.reserveSummary}><div><span>목표 금액</span><strong>{money(Number(row.target_amount))}</strong></div><div className={styles.currentReserveRow}><span>현재 확보 금액</span><strong>{money(row.currentAmount)}</strong></div><div><span aria-label="부족 금액">남은 금액</span><strong>{money(row.remainingAmount)}</strong></div></div>
      {pending ? <div className={styles.pendingPanel}><div><span>확정 대기 중</span><strong>{monthLabel(pending.scheduledMonth)} 적립 예정 · {money(pending.plannedAmount)}</strong><small>확정하면 실제 준비금이 증가합니다.</small></div><div className={styles.buttonRow}><button className={styles.confirmButton} disabled={working} onClick={() => void resolveSchedule(pending.id, { action: "confirm" })}>적립 확정</button><button className={styles.secondary} disabled={working} onClick={() => { const reason = window.prompt("건너뛰기 사유"); if (reason && reason.trim()) void resolveSchedule(pending.id, { action: "skip", reason: reason.trim() }); }}>건너뛰기</button></div></div> : null}
      <div className={styles.reserveNav}>{([[
        "plan", "계획 정보"], ["recurring", "정기 적립"], ["entry", "직접 조정"], ["history", "이력"]] as const).map(([value, label]) => <button type="button" key={value} className={openSection === value ? styles.reserveNavActive : undefined} onClick={() => setOpenSection(current => current === value ? null : value)} aria-expanded={openSection === value}><span>{label}</span><span aria-hidden>{openSection === value ? "⌃" : "›"}</span></button>)}</div>
      {openSection === "plan" ? <section className={styles.detailBody}>
        <h4>계획 정보</h4>
        <div className={styles.reserveFormGrid}><label>💰 목표 금액<input className={styles.input} type="text" inputMode="decimal" value={formatNumericInput(amount)} onChange={event => setAmount(normalizeNumericInput(event.target.value))} /></label><label>🎯 목표일<input className={styles.input} type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label className={styles.reserveFullField}>🏦 연결 계좌<select className={styles.input} value={account} disabled={accountLocked} onChange={event => setAccount(event.target.value)}><option value="">미연결</option>{eligibleAccounts.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label><label className={styles.reserveFullField}>🗒️ 메모<input className={styles.input} value={memo} onChange={event => setMemo(event.target.value)} /></label></div>
        {accountLocked ? <p className={`${styles.infoPanel} ${styles.compactDetailInfo}`}>확보된 준비금이 있어 연결 계좌를 변경할 수 없습니다. 먼저 준비금을 전액 해제하세요.</p> : <p className={`${styles.infoPanel} ${styles.compactDetailInfo}`}>계좌 연결만으로 준비금이 자동 적립되지는 않습니다.</p>}
        <button className={`${styles.secondary} ${styles.detailAction}`} disabled={working} onClick={() => void savePlan(row.id, { targetAmount: Number(amount), targetDate: date || null, fundAccountId: account ? Number(account) : null, memo })}>계획 수정</button>
      </section> : null}
      {openSection === "entry" ? <section className={styles.detailBody}>
        <h4>직접 조정</h4>
        <div className={styles.entryTypes}>{Object.entries(RESERVE_ENTRY_LABELS).map(([value, label]) => <button type="button" key={value} className={entryType === value ? styles.entryTypeActive : undefined} onClick={() => setEntryType(value)}>{label}</button>)}</div>
        <p className={`${entryType === "allocate" ? styles.infoPanel : styles.warningPanel} ${styles.compactDetailInfo}`}>{RESERVE_ENTRY_DESCRIPTIONS[entryType]}</p>
        <div className={styles.reserveFormGrid}><label>💰 금액<input className={styles.input} type="number" step="0.001" value={entryAmount} onChange={event => setEntryAmount(event.target.value)} /></label><label>🕒 일시<input className={styles.input} type="datetime-local" value={occurredAt} onChange={event => setOccurredAt(event.target.value)} /></label><label className={styles.reserveFullField}>🗒️ 메모<input className={styles.input} value={entryMemo} onChange={event => setEntryMemo(event.target.value)} /></label></div>
        <button className={`${entryType === "allocate" ? styles.primary : styles.secondary} ${entryType === "allocate" ? "" : styles.riskAction} ${styles.detailAction}`} disabled={working || !entryAmount} onClick={() => void addEntry(row.id, { entryType, amount: Number(entryAmount), occurredAt: `${occurredAt}:00+07:00`, memo: entryMemo || null }).then(() => { setEntryAmount(""); setEntryMemo(""); })}>{RESERVE_ENTRY_LABELS[entryType]} 기록</button>
      </section> : null}
      {openSection === "recurring" ? <section className={styles.detailBody}>
        <h4>정기 적립</h4><p className={`${styles.infoPanel} ${styles.compactDetailInfo}`}>ℹ️ 정기 적립 예정이 생성되어도 준비금은 바로 증가하지 않습니다.<br />관리자가 확정한 경우에만 실제 준비금에 반영됩니다.</p>
        <div className={styles.reserveFormGrid}><label>💰 월 적립액<input className={styles.input} type="number" min="0.001" step="0.001" value={recMonthly} onChange={event => setRecMonthly(event.target.value)} /></label><label>📅 매월 적립일<input className={styles.input} type="number" min="1" max="31" value={recDay} onChange={event => setRecDay(event.target.value)} /></label><label>🗓️ 시작월<input className={styles.input} type="month" value={recStart} onChange={event => setRecStart(event.target.value)} /></label><label>🏁 종료월<input className={styles.input} type="month" aria-label="종료월(선택)" value={recEnd} onChange={event => setRecEnd(event.target.value)} /></label></div>
        <label className={styles.toggleRow}><span><strong>자동 예정 생성</strong><small>매월 적립일 이후 예정이 자동으로 생성됩니다.</small></span><input type="checkbox" role="switch" checked={recAuto} onChange={event => setRecAuto(event.target.checked)} /></label>{recAuto && !row.fundAccount ? <p className={styles.error}>자동 예정 생성은 연결 계좌가 필요합니다. 계획 정보에서 계좌를 먼저 연결하세요.</p> : null}<p className={styles.sectionDescription}>자동 예정 생성이 꺼져 있어도 &ldquo;이번 달 예정 생성&rdquo; 버튼으로 수동 생성할 수 있습니다.</p>
        <div className={styles.buttonRow}><button className={styles.primary} disabled={working || !recMonthly || !recDay || !recStart} onClick={() => void saveRecurring(row.id, { monthlyAmount: Number(recMonthly), recurringDay: Number(recDay), startMonth: `${recStart}-01`, endMonth: recEnd ? `${recEnd}-01` : null, autoGenerate: recAuto })}>정기 적립 저장</button>{row.recurring ? <button className={`${styles.secondary} ${styles.destructiveSecondary}`} disabled={working} onClick={() => void saveRecurring(row.id, { monthlyAmount: null })}>설정 해제</button> : null}{!pending && row.recurring && !row.targetReached ? <button className={styles.secondary} disabled={working} onClick={() => void generateSchedule()}>이번 달 예정 생성</button> : null}</div>
        {row.targetReached ? <p className={styles.infoPanel}>목표 금액을 달성하여 신규 정기 적립 예정이 생성되지 않습니다.</p> : null}
      </section> : null}
      {openSection === "history" ? <section className={styles.detailBody}><h4>이력</h4><div className={styles.historyCounts}><span>정기 예정 <strong>{recentSchedules.length}건</strong></span><span>준비금 기록 <strong>{entries.length}건</strong></span></div>{!recentSchedules.length && !entries.length ? <p className={styles.compactEmpty}>아직 준비금 이력이 없습니다.</p> : <>{recentSchedules.length ? <div className={styles.historyGroup}><strong>정기 적립 예정</strong><div className={styles.historyList}>{recentSchedules.map(schedule => <div className={styles.historyRow} key={schedule.id}><div><strong>{monthLabel(schedule.scheduledMonth)}</strong><span>{RESERVE_SCHEDULE_STATUS_LABELS[schedule.status] ?? schedule.status}</span></div><div><strong>{money(schedule.plannedAmount)}</strong><span>{schedule.skipReason ?? "비고 없음"}</span></div></div>)}</div></div> : null}{entries.length ? <div className={styles.historyGroup}><strong>준비금 기록</strong><div className={styles.historyList}>{entries.map(entry => <div className={styles.historyRow} key={entry.id}><div><strong>{RESERVE_ENTRY_LABELS[entry.entry_type] ?? entry.entry_type}</strong><span>{formatReserveDateTime(entry.occurred_at)}</span></div><div><strong>{money(Number(entry.amount))}</strong><span>{entry.memo ?? "메모 없음"}</span></div></div>)}</div></div> : null}</>}</section> : null}
    </article>
  );
}
