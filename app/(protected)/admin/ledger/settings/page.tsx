"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import PartnerSettingsPanel from "@/components/partners/PartnerSettingsPanel";
import { useLanguage } from "@/lib/language-context";
import { LEDGER_SETTINGS_TABS, ledgerSettingsHref, ledgerSettingsTabText, parseLedgerSettingsTab, parsePartnerSettingsView, type LedgerSettingsTab } from "@/lib/partners/settings-view";
import { ownerCompositionStartMonth } from "@/lib/ledger/owner-settings-view";
import { shortLedgerAccountName } from "@/lib/ledger/entry-display-account";
import { RESERVE_ENTRY_TYPE_KEYS, reserveEntryTypeLabel, reserveEntryTypeText, type ReserveEntryTypeKey } from "@/lib/ledger/reserve-text";
import { ledgerSettingsText, type LedgerSettingsCopy } from "@/lib/ledger/settings-text";
import styles from "../ledger-settings.module.css";

type Account = { id: number; code: string; type: string; display_name: string; is_active: boolean; is_business_fund?: boolean };
type ReserveEntry = { id: number; entry_type: string; amount: number | string; occurred_at: string; memo: string | null };
type ReserveFundAccount = { id: number; code: string; displayName: string };
type ReserveRecurring = { monthlyAmount: number; recurringDay: number; startMonth: string; endMonth: string | null; autoGenerate: boolean };
type ReserveSchedule = { id: number; scheduledMonth: string; scheduledDate: string; plannedAmount: number; status: string; skipReason: string | null; reserveEntryId: number | null; resolvedAt: string | null };
type Reserve = { id: number; name: string; target_amount: number; target_date: string | null; is_active: boolean; memo: string | null; fund_account_id: number | null; fundAccount: ReserveFundAccount | null; currentAmount: number; remainingAmount: number; entries: ReserveEntry[] | null; recurring: ReserveRecurring | null; pendingSchedule: ReserveSchedule | null; recentSchedules: ReserveSchedule[] | null; targetReached: boolean };
type EligibleAccount = { id: number; code: string; displayName: string; type: string };
type User = { id: number; name?: string; full_name?: string; username?: string };
type Participant = { id: number; user_id: number; sort_order: number; effective_from: string };
type OwnerData = { users: User[]; participants: Participant[]; settings: { tracking_start_month?: string; opening_undistributed_profit?: number } | null; policy: { effective_month: string; revision: number; lines: Array<{ participant_id: number; settlement_rate: string }> } | null };
type LedgerData = { accounts: Account[] };
const currentMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;
const localDateTime = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 16);
const formatReserveDateTime = (value: string, locale: string) => new Intl.DateTimeFormat(locale, { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
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
// Display labels only (ledger_fund_accounts rows are unchanged). Korean keeps the
// stored display_name unless an override exists; short names reuse the ledger's
// shortLedgerAccountName, keyed by the canonical ledger account name.
const ACCOUNT_UI: Record<string, { order: number; emoji: string; ledgerName: string; name: { ko?: string; vi: string } }> = {
  store_cash: { order: 0, emoji: "💵", ledgerName: "매장 현금", name: { vi: "Tiền mặt cửa hàng" } },
  baba_corporate_bank: { order: 1, emoji: "🏦", ledgerName: "BABA 법인계좌", name: { vi: "Tài khoản công ty BABA" } },
  vuong_personal_custody: { order: 2, emoji: "👤", ledgerName: "개인(Vương)", name: { ko: "개인(Vương)", vi: "Cá nhân (Vương)" } },
  cho_personal_custody: { order: 3, emoji: "👤", ledgerName: "개인(Cho)", name: { ko: "개인(Cho)", vi: "Cá nhân (Cho)" } },
};
// card_clearing stays a backend clearing account (is_business_fund=false); the
// settings list shows only the user-facing business fund accounts.
const isUserFundAccount = (account: Account) => account.is_business_fund === true && account.type !== "card_clearing";
const rateMicros = (percent: string) => Number(toRate(percent).replace(".", ""));
const toRate = (percent: string) => {
  const [whole = "0", fraction = ""] = percent.trim().split(".");
  const million = BigInt(1_000_000);
  const scaled = (BigInt(whole || "0") * million + BigInt((fraction + "000000").slice(0, 6))) / BigInt(100);
  return `${scaled / million}.${String(scaled % million).padStart(6, "0")}`;
};

export default function LedgerSettingsPage() {
  return <Suspense fallback={null}><LedgerSettingsContent /></Suspense>;
}

function LedgerSettingsContent() {
  const month = useMemo(currentMonth, []);
  const { lang } = useLanguage();
  const tabText = ledgerSettingsTabText[lang];
  const copy = ledgerSettingsText[lang];
  const router = useRouter();
  const searchParams = useSearchParams();
  // ?tab=basic|partners|reserves (&view=pending|active|inactive for 거래처) keeps deep links working.
  const activeTab = parseLedgerSettingsTab(searchParams.get("tab"));
  const partnerView = parsePartnerSettingsView(searchParams.get("view"));
  const [ledger, setLedger] = useState<LedgerData | null>(null);
  const [reserves, setReserves] = useState<Reserve[]>([]);
  const [eligibleAccounts, setEligibleAccounts] = useState<EligibleAccount[]>([]);
  const [owners, setOwners] = useState<OwnerData | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [fundAccountsOpen, setFundAccountsOpen] = useState(true);
  const [ownerSettlementOpen, setOwnerSettlementOpen] = useState(true);
  const [participantEditorOpen, setParticipantEditorOpen] = useState(false);
  const [policyEditorOpen, setPolicyEditorOpen] = useState(false);
  const [reserveFormOpen, setReserveFormOpen] = useState(false);
  const [reserve, setReserve] = useState({ name: "", targetAmount: "", targetDate: "", fundAccountId: "", memo: "" });
  const [participantEffectiveMonth, setParticipantEffectiveMonth] = useState("");
  const [policyEffectiveMonth, setPolicyEffectiveMonth] = useState(month);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [rates, setRates] = useState<Record<number, string>>({});

  // Each tab reads only its own data: 기본설정 = fund accounts + owner settlement,
  // 준비금 = reserves, 거래처 = PartnerSettingsPanel's single /api/admin/partners read.
  const loadBasic = useCallback(async () => {
    const responses = await Promise.all([
      // Lightweight reads: fund-account balances only, and owner settings only.
      fetch(`/api/admin/ledger?month=${month}&scope=accounts`, { cache: "no-store" }),
      fetch(`/api/admin/ledger/owners?throughMonth=${month}&mode=settings`, { cache: "no-store" }),
    ]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    const failed = responses.findIndex(response => !response.ok);
    if (failed >= 0) throw new Error(bodies[failed]?.code ?? "LOAD_FAILED");
    setLedger({ accounts: bodies[0].accounts }); setOwners(bodies[1]);
    setSelectedUsers((bodies[1].participants as Participant[]).map(row => String(row.user_id)));
    setRates(Object.fromEntries((bodies[1].policy?.lines ?? []).map((line: { participant_id: number; settlement_rate: string }) => [line.participant_id, String(Number(line.settlement_rate) * 100)])));
  }, [month]);
  const loadReserves = useCallback(async () => {
    const response = await fetch("/api/admin/ledger/reserves", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.code ?? "LOAD_FAILED");
    setReserves(body.plans); setEligibleAccounts(body.eligibleAccounts ?? []);
  }, []);
  const load = activeTab === "reserves" ? loadReserves : loadBasic;
  useEffect(() => {
    if (activeTab === "partners") return;
    void load().catch(cause => setError(copy.loadFailed((cause as Error).message)));
  }, [activeTab, load, copy]);

  function selectTab(tab: LedgerSettingsTab) {
    setMessage(""); setError("");
    router.replace(ledgerSettingsHref(tab, tab === "partners" ? partnerView : undefined), { scroll: false });
  }

  async function mutate(url: string, body: Record<string, unknown>, method = "POST") {
    setWorking(true); setError(""); setMessage("");
    try { const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(result.code); setMessage(copy.saved); await load(); }
    catch (cause) { setError(copy.saveFailed((cause as Error).message)); }
    finally { setWorking(false); }
  }
  // Creating a plan only records a target and (optionally) where the money will be kept.
  // It never books an allocate entry — actual reserved money grows only via the entry controls below.
  async function createReserve(event: FormEvent) { event.preventDefault(); await mutate("/api/admin/ledger/reserves", { name: reserve.name, targetAmount: Number(reserve.targetAmount), targetDate: reserve.targetDate || null, linkedRecurringPlanId: null, fundAccountId: reserve.fundAccountId ? Number(reserve.fundAccountId) : null, memo: reserve.memo }); setReserve({ name: "", targetAmount: "", targetDate: "", fundAccountId: "", memo: "" }); }
  async function saveReservePlan(id: number, body: Record<string, unknown>) { await mutate(`/api/admin/ledger/reserves/${id}`, body, "PATCH"); }
  async function addReserveEntry(id: number, body: Record<string, unknown>) { await mutate(`/api/admin/ledger/reserves/${id}/entries`, body); }
  async function saveReserveRecurring(id: number, body: Record<string, unknown>) { await mutate(`/api/admin/ledger/reserves/${id}/recurring`, body, "PUT"); }
  async function generateReserveSchedule() { await mutate("/api/admin/ledger/reserves/schedule", { month }); }
  async function resolveReserveSchedule(scheduleId: number, body: Record<string, unknown>) { await mutate(`/api/admin/ledger/reserves/schedule/${scheduleId}`, body); }

  const userFundAccounts = (ledger?.accounts ?? []).filter(isUserFundAccount);
  const activeAccountCount = userFundAccounts.filter(row => row.is_active).length;
  const inactiveAccountCount = userFundAccounts.length - activeAccountCount;
  const displayedAccounts = [...userFundAccounts].sort((left, right) => (ACCOUNT_UI[left.code]?.order ?? 999) - (ACCOUNT_UI[right.code]?.order ?? 999));
  const ownerUserName = (userId: number) => {
    const user = owners?.users.find(item => item.id === userId);
    return user?.name ?? user?.full_name ?? user?.username ?? copy.userFallback(userId);
  };
  const ownerRateTotal = owners?.participants.reduce((total, participant) => total + (Number(rates[participant.id]) || 0), 0) ?? 0;
  // Same conversion the save sends; the server requires the rates to sum to exactly 1.000000.
  const ownerRateTotalValid = (owners?.participants.length ?? 0) > 0 && owners!.participants.reduce((total, participant) => total + rateMicros(rates[participant.id] ?? "0"), 0) === 1_000_000;
  const percentFormat = new Intl.NumberFormat(copy.dateLocale, { maximumFractionDigits: 4 });
  const policySummary = owners?.policy?.lines.length
    ? owners.policy.lines.map(line => { const participant = owners.participants.find(row => row.id === line.participant_id); return `${participant ? ownerUserName(participant.user_id) : copy.userFallback(line.participant_id)} ${percentFormat.format(Number(line.settlement_rate) * 100)}%`; }).join(" · ")
    : null;
  const participantEditorVisible = participantEditorOpen || owners?.participants.length === 0;
  const compositionStartMonth = ownerCompositionStartMonth(owners?.participants ?? []);
  const participantForm = <div className={styles.settingEditor}>
    <label className={styles.editorField}><span>{owners?.participants.length ? copy.participantChangeMonth : copy.participantStartMonth}</span><input className={styles.input} type="month" value={participantEffectiveMonth} onChange={event => setParticipantEffectiveMonth(event.target.value)} /></label>
    {!owners?.participants.length ? <p className={styles.mutedHelp}>{copy.participantStartHelp}</p> : null}
    <div className={styles.editorLabelRow}><span>{copy.selectInvestors}</span><small>{copy.selectedOfThree(selectedUsers.length)}</small></div>
    <div className={styles.ownerChoiceGrid}>{owners?.users.map(user => { const selected = selectedUsers.includes(String(user.id)); return <label className={`${styles.ownerChip} ${selected ? styles.ownerChipActive : ""}`} key={user.id}><input className={styles.visuallyHidden} type="checkbox" checked={selected} onChange={event => setSelectedUsers(event.target.checked ? [...selectedUsers, String(user.id)] : selectedUsers.filter(id => id !== String(user.id)))} /><span aria-hidden>{selected ? "✓" : ""}</span><span>{user.name ?? user.full_name ?? user.username ?? copy.userFallback(user.id)}</span></label>; })}</div>
    <button className={`${styles.primary} ${styles.ownerAction}`} disabled={working || selectedUsers.length !== 3 || !participantEffectiveMonth} onClick={() => void mutate("/api/admin/ledger/owners", { action: "participants", effectiveMonth: `${participantEffectiveMonth}-01`, rows: selectedUsers.map((userId, index) => ({ userId: Number(userId), isEligible: true, sortOrder: index + 1 })) })}>{copy.saveParticipants}</button>
  </div>;
  return <Container noPaddingTop><main className={styles.page}>
    <div className={styles.tabs} role="tablist" aria-label={tabText.tabsLabel}>
      {LEDGER_SETTINGS_TABS.map(value => <button key={value} type="button" role="tab" aria-selected={activeTab === value} className={activeTab === value ? styles.activeTab : styles.tab} onClick={() => selectTab(value)}>{tabText[value]}</button>)}
    </div>
    {message ? <p role="status" className={styles.notice}>{message}</p> : null}{error ? <p role="alert" className={styles.error}>{error}</p> : null}

    {activeTab === "basic" ? <section className={styles.sectionStack} role="tabpanel">
      <section className={`${styles.card} ${styles.accordionCard}`}>
        <button type="button" className={styles.accordionHeader} aria-expanded={fundAccountsOpen} aria-controls="settings-fund-accounts" onClick={() => setFundAccountsOpen(value => !value)}><h2>🏦 {tabText.fundAccounts}</h2><span className={styles.countBadge}>{ledger ? tabText.accountCount(activeAccountCount) : "…"}</span><span className={styles.accordionChevron} aria-hidden>{fundAccountsOpen ? "⌃" : "›"}</span></button>
        {fundAccountsOpen ? <div id="settings-fund-accounts" className={styles.accordionBody}>{inactiveAccountCount > 0 ? <p className={styles.sectionDescription}>{copy.activeInactive(activeAccountCount, inactiveAccountCount)}</p> : null}<div className={`${styles.accountGrid} ${styles.accountGridTwo}`}>{displayedAccounts.map(row => { const accountUi = ACCOUNT_UI[row.code]; return <div className={styles.accountCard} key={row.id}><div><strong><span aria-hidden>{accountUi?.emoji ?? "💰"}</span>{accountUi?.name[lang] ?? row.display_name}</strong><span>{shortLedgerAccountName(accountUi?.ledgerName ?? row.display_name, lang)}</span></div>{!row.is_active ? <span className={styles.statusInactive}>{copy.accountInactive}</span> : null}</div>; })}</div></div> : null}
      </section>
      <section className={`${styles.card} ${styles.accordionCard} ${styles.ownerCard}`}>
        <button type="button" className={styles.accordionHeader} aria-expanded={ownerSettlementOpen} aria-controls="settings-owner-settlement" onClick={() => setOwnerSettlementOpen(value => !value)}><h2>🤝 {tabText.ownerSettlement}</h2><span className={styles.countBadge}>{owners ? tabText.participantCount(owners.participants.length) : "…"}</span><span className={styles.accordionChevron} aria-hidden>{ownerSettlementOpen ? "⌃" : "›"}</span></button>
        {ownerSettlementOpen && owners ? <div id="settings-owner-settlement" className={styles.accordionBody}>
          <div className={styles.ownerSummary}>
            <div><span>🗓️ {copy.compositionStart}</span><strong>{compositionStartMonth ?? copy.notSet}</strong></div>
            <div><span>👥 {copy.investors}</span><strong>{copy.peopleCount(owners.participants.length)}</strong></div>
            <div><span>↩️ {copy.recoveryBasis}</span><strong>{copy.recoveryBasisValue}</strong></div>
            <div><span>⚖️ {copy.profitShareRate}</span><strong>{owners.policy ? copy.configured : copy.notSet}</strong></div>
          </div>
          <div className={styles.settingRows}>
            <div className={styles.settingRow}>
              <div className={styles.settingRowMain}><span className={styles.settingRowTitle}>{copy.investorComposition}</span><strong>{owners.participants.length ? owners.participants.map(row => ownerUserName(row.user_id)).join(" · ") : copy.notSet}</strong>{compositionStartMonth ? <small>{copy.appliedFrom(compositionStartMonth)}</small> : null}</div>
              {owners.participants.length ? <button type="button" className={styles.settingRowAction} aria-expanded={participantEditorOpen} aria-controls="owner-participant-editor" onClick={() => setParticipantEditorOpen(value => !value)}>{participantEditorOpen ? copy.close : copy.change}</button> : null}
            </div>
            {participantEditorVisible ? <div id="owner-participant-editor">{participantForm}</div> : null}
            <div className={styles.settingRow}>
              <div className={styles.settingRowMain}><span className={styles.settingRowTitle}>{copy.profitShareRate}</span><strong>{policySummary ?? copy.notSet}</strong></div>
              {owners.participants.length ? <button type="button" className={styles.settingRowAction} aria-expanded={policyEditorOpen} aria-controls="owner-policy-editor" onClick={() => setPolicyEditorOpen(value => !value)}>{policyEditorOpen ? copy.close : owners.policy ? copy.change : copy.setup}</button> : <small className={styles.mutedHelp}>{copy.investorsFirst}</small>}
            </div>
            {policyEditorOpen && owners.participants.length ? <div id="owner-policy-editor" className={styles.settingEditor}>
            <label className={styles.editorField}><span>{copy.applyMonth}</span><input className={styles.input} type="month" value={policyEffectiveMonth} onChange={event => setPolicyEffectiveMonth(event.target.value)} /></label>
            <div className={styles.ownerRateList}>{owners.participants.map(row => <label className={styles.ownerRateRow} key={row.id}><span>{ownerUserName(row.user_id)}</span><span className={styles.rateInput}><input className={styles.input} inputMode="decimal" value={rates[row.id] ?? ""} onChange={event => setRates({ ...rates, [row.id]: event.target.value })} /><span>%</span></span></label>)}</div>
            <div className={styles.rateTotal}><span>{copy.profitShareTotal}</span><strong className={ownerRateTotalValid ? undefined : styles.rateTotalInvalid}>{copy.rateTotalOf(percentFormat.format(ownerRateTotal))}</strong></div>
            {!ownerRateTotalValid ? <p className={styles.rateTotalHint} role="status">{copy.rateMustBe100}</p> : null}
            <p className={styles.mutedHelp}>{copy.profitShareHelp}</p>
            <button className={`${styles.primary} ${styles.ownerAction}`} disabled={working || !policyEffectiveMonth || !ownerRateTotalValid} onClick={() => void mutate("/api/admin/ledger/owners", { action: "policy", effectiveMonth: `${policyEffectiveMonth}-01`, lines: owners.participants.map(row => ({ participantId: row.id, rate: toRate(rates[row.id] ?? "0") })), note: "Owner settlement policy" })}>{copy.saveProfitShare}</button>
            </div> : null}
          </div>
        </div> : null}
      </section>
    </section> : null}

    {activeTab === "partners" ? <section className={styles.sectionStack} role="tabpanel">
      <PartnerSettingsPanel lang={lang} view={partnerView} onViewChange={view => router.replace(ledgerSettingsHref("partners", view), { scroll: false })} />
    </section> : null}

    {activeTab === "reserves" ? <section className={styles.sectionStack} role="tabpanel">
      <section className={styles.card}><div className={styles.cardHeader}><div><h2>{copy.reserves}</h2></div><button type="button" className={`${styles.secondarySmall} ${styles.reserveAddButton}`} aria-expanded={reserveFormOpen} onClick={() => setReserveFormOpen(value => !value)}>{reserveFormOpen ? copy.closeAdd : copy.addReserve}</button></div><div className={`${styles.infoPanel} ${styles.compactInfo}`}>{copy.reserveInfo}</div>{reserveFormOpen ? <form className={styles.formGrid} onSubmit={createReserve}><label>{copy.reserveName}<input required className={styles.input} value={reserve.name} onChange={event => setReserve({ ...reserve, name: event.target.value })} /></label><label>{copy.targetAmount}<input required type="number" min="0.001" step="0.001" className={styles.input} value={reserve.targetAmount} onChange={event => setReserve({ ...reserve, targetAmount: event.target.value })} /></label><label>{copy.targetDate}<input type="date" className={styles.input} value={reserve.targetDate} onChange={event => setReserve({ ...reserve, targetDate: event.target.value })} /></label><label>{copy.linkedAccount}<select className={styles.input} value={reserve.fundAccountId} onChange={event => setReserve({ ...reserve, fundAccountId: event.target.value })}><option value="">{copy.unlinked}</option>{eligibleAccounts.map(account => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label><label className={styles.spanTwo}>{copy.memo}<input className={styles.input} value={reserve.memo} onChange={event => setReserve({ ...reserve, memo: event.target.value })} /></label><p className={`${styles.infoPanel} ${styles.spanTwo}`}>{copy.createPlanHelp}</p><button className={styles.primary} disabled={working}>{copy.createPlan}</button></form> : null}<div className={styles.reserveList}>{reserves.map(row => <ReservePlanCard key={row.id} row={row} month={month} lang={lang} copy={copy} eligibleAccounts={eligibleAccounts} working={working} savePlan={saveReservePlan} addEntry={addReserveEntry} saveRecurring={saveReserveRecurring} generateSchedule={generateReserveSchedule} resolveSchedule={resolveReserveSchedule} />)}</div></section>
    </section> : null}
  </main></Container>;
}

function ReservePlanCard({ row, month, lang, copy, eligibleAccounts, working, savePlan, addEntry, saveRecurring, generateSchedule, resolveSchedule }: {
  row: Reserve;
  month: string;
  lang: "ko" | "vi";
  copy: LedgerSettingsCopy;
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
  const [entryType, setEntryType] = useState<ReserveEntryTypeKey>("allocate");
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
      <header className={styles.reserveHeader}><div><span className={styles.overline}>{copy.planOverline}</span><h3>{row.name}</h3><div className={styles.reserveMeta}><span>🏦 {row.fundAccount?.displayName ?? copy.accountNotSet}</span><span className={row.recurring ? styles.statusActive : styles.statusInactive}>{row.recurring ? copy.recurringOn : copy.recurringOff}</span></div></div></header>
      <div className={styles.reserveSummary}><div><span>{copy.targetAmount}</span><strong>{money(Number(row.target_amount))}</strong></div><div className={styles.currentReserveRow}><span>{copy.currentAmount}</span><strong>{money(row.currentAmount)}</strong></div><div><span aria-label={copy.shortfallAria}>{copy.remainingAmount}</span><strong>{money(row.remainingAmount)}</strong></div></div>
      {pending ? <div className={styles.pendingPanel}><div><span>{copy.pendingTitle}</span><strong>{copy.pendingPlanned(monthLabel(pending.scheduledMonth), money(pending.plannedAmount))}</strong><small>{copy.pendingHelp}</small></div><div className={styles.buttonRow}><button className={styles.confirmButton} disabled={working} onClick={() => void resolveSchedule(pending.id, { action: "confirm" })}>{copy.confirmAllocation}</button><button className={styles.secondary} disabled={working} onClick={() => { const reason = window.prompt(copy.skipReasonPrompt); if (reason && reason.trim()) void resolveSchedule(pending.id, { action: "skip", reason: reason.trim() }); }}>{copy.skip}</button></div></div> : null}
      <div className={styles.reserveNav}>{([[
        "plan", copy.sectionPlan], ["recurring", copy.sectionRecurring], ["entry", copy.sectionEntry], ["history", copy.sectionHistory]] as const).map(([value, label]) => <button type="button" key={value} className={openSection === value ? styles.reserveNavActive : undefined} onClick={() => setOpenSection(current => current === value ? null : value)} aria-expanded={openSection === value}><span>{label}</span><span aria-hidden>{openSection === value ? "⌃" : "›"}</span></button>)}</div>
      {openSection === "plan" ? <section className={styles.detailBody}>
        <h4>{copy.sectionPlan}</h4>
        <div className={styles.reserveFormGrid}><label>💰 {copy.targetAmount}<input className={styles.input} type="text" inputMode="decimal" value={formatNumericInput(amount)} onChange={event => setAmount(normalizeNumericInput(event.target.value))} /></label><label>🎯 {copy.targetDate}<input className={styles.input} type="date" value={date} onChange={event => setDate(event.target.value)} /></label><label className={styles.reserveFullField}>🏦 {copy.linkedAccount}<select className={styles.input} value={account} disabled={accountLocked} onChange={event => setAccount(event.target.value)}><option value="">{copy.unlinked}</option>{eligibleAccounts.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label><label className={styles.reserveFullField}>🗒️ {copy.memo}<input className={styles.input} value={memo} onChange={event => setMemo(event.target.value)} /></label></div>
        {accountLocked ? <p className={`${styles.infoPanel} ${styles.compactDetailInfo}`}>{copy.accountLocked}</p> : <p className={`${styles.infoPanel} ${styles.compactDetailInfo}`}>{copy.accountLinkHelp}</p>}
        <button className={`${styles.secondary} ${styles.detailAction}`} disabled={working} onClick={() => void savePlan(row.id, { targetAmount: Number(amount), targetDate: date || null, fundAccountId: account ? Number(account) : null, memo })}>{copy.updatePlan}</button>
      </section> : null}
      {openSection === "entry" ? <section className={styles.detailBody}>
        <h4>{copy.sectionEntry}</h4>
        <div className={styles.entryTypes}>{RESERVE_ENTRY_TYPE_KEYS.map(value => <button type="button" key={value} className={entryType === value ? styles.entryTypeActive : undefined} onClick={() => setEntryType(value)}>{reserveEntryTypeLabel(value, lang)}</button>)}</div>
        <p className={`${entryType === "allocate" ? styles.infoPanel : styles.warningPanel} ${styles.compactDetailInfo}`}>{copy.entryDescriptions[entryType]}</p>
        <div className={styles.reserveFormGrid}><label>💰 {copy.amount}<input className={styles.input} type="number" step="0.001" value={entryAmount} onChange={event => setEntryAmount(event.target.value)} /></label><label>🕒 {copy.occurredAt}<input className={styles.input} type="datetime-local" value={occurredAt} onChange={event => setOccurredAt(event.target.value)} /></label><label className={styles.reserveFullField}>🗒️ {copy.memo}<input className={styles.input} value={entryMemo} onChange={event => setEntryMemo(event.target.value)} /></label></div>
        <button className={`${entryType === "allocate" ? styles.primary : styles.secondary} ${entryType === "allocate" ? "" : styles.riskAction} ${styles.detailAction}`} disabled={working || !entryAmount} onClick={() => void addEntry(row.id, { entryType, amount: Number(entryAmount), occurredAt: `${occurredAt}:00+07:00`, memo: entryMemo || null }).then(() => { setEntryAmount(""); setEntryMemo(""); })}>{copy.recordEntry(reserveEntryTypeLabel(entryType, lang))}</button>
      </section> : null}
      {openSection === "recurring" ? <section className={styles.detailBody}>
        <h4>{copy.sectionRecurring}</h4><p className={`${styles.infoPanel} ${styles.compactDetailInfo}`}>{copy.recurringInfoLine1}<br />{copy.recurringInfoLine2}</p>
        <div className={styles.reserveFormGrid}><label>💰 {copy.monthlyAmount}<input className={styles.input} type="number" min="0.001" step="0.001" value={recMonthly} onChange={event => setRecMonthly(event.target.value)} /></label><label>📅 {copy.recurringDay}<input className={styles.input} type="number" min="1" max="31" value={recDay} onChange={event => setRecDay(event.target.value)} /></label><label>🗓️ {copy.startMonth}<input className={styles.input} type="month" value={recStart} onChange={event => setRecStart(event.target.value)} /></label><label>🏁 {copy.endMonth}<input className={styles.input} type="month" aria-label={copy.endMonthAria} value={recEnd} onChange={event => setRecEnd(event.target.value)} /></label></div>
        <label className={styles.toggleRow}><span><strong>{copy.autoGenerate}</strong><small>{copy.autoGenerateHelp}</small></span><input type="checkbox" role="switch" checked={recAuto} onChange={event => setRecAuto(event.target.checked)} /></label>{recAuto && !row.fundAccount ? <p className={styles.error}>{copy.autoGenerateNeedsAccount}</p> : null}<p className={styles.sectionDescription}>{copy.manualGenerateHelp}</p>
        <div className={styles.buttonRow}><button className={styles.primary} disabled={working || !recMonthly || !recDay || !recStart} onClick={() => void saveRecurring(row.id, { monthlyAmount: Number(recMonthly), recurringDay: Number(recDay), startMonth: `${recStart}-01`, endMonth: recEnd ? `${recEnd}-01` : null, autoGenerate: recAuto })}>{copy.saveRecurring}</button>{row.recurring ? <button className={`${styles.secondary} ${styles.destructiveSecondary}`} disabled={working} onClick={() => void saveRecurring(row.id, { monthlyAmount: null })}>{copy.clearRecurring}</button> : null}{!pending && row.recurring && !row.targetReached ? <button className={styles.secondary} disabled={working} onClick={() => void generateSchedule()}>{copy.generateThisMonth}</button> : null}</div>
        {row.targetReached ? <p className={styles.infoPanel}>{copy.targetReached}</p> : null}
      </section> : null}
      {openSection === "history" ? <section className={styles.detailBody}><h4>{copy.sectionHistory}</h4><div className={styles.historyCounts}><span>{copy.scheduledCount} <strong>{copy.itemCount(recentSchedules.length)}</strong></span><span>{copy.entryCount} <strong>{copy.itemCount(entries.length)}</strong></span></div>{!recentSchedules.length && !entries.length ? <p className={styles.compactEmpty}>{copy.noHistory}</p> : <>{recentSchedules.length ? <div className={styles.historyGroup}><strong>{copy.scheduledHistory}</strong><div className={styles.historyList}>{recentSchedules.map(schedule => <div className={styles.historyRow} key={schedule.id}><div><strong>{monthLabel(schedule.scheduledMonth)}</strong><span>{copy.scheduleStatus[schedule.status] ?? schedule.status}</span></div><div><strong>{money(schedule.plannedAmount)}</strong><span>{schedule.skipReason ?? copy.noNote}</span></div></div>)}</div></div> : null}{entries.length ? <div className={styles.historyGroup}><strong>{copy.entryCount}</strong><div className={styles.historyList}>{entries.map(entry => <div className={styles.historyRow} key={entry.id}><div><strong>{reserveEntryTypeText(entry.entry_type, lang)}</strong><span>{formatReserveDateTime(entry.occurred_at, copy.dateLocale)}</span></div><div><strong>{money(Number(entry.amount))}</strong><span>{entry.memo ?? copy.noMemo}</span></div></div>)}</div></div> : null}</>}</section> : null}
    </article>
  );
}
