"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { rentText, type RentCopy } from "@/lib/ledger/rent-text";
import type { RentContract, RentPayment, RentUsageStatus } from "@/lib/ledger/rent-contracts";
import styles from "../ledger-settings.module.css";

type Account = { code: string; displayName: string } | null;
type ReservePlan = {
  id: number; name: string; targetAmount: number; targetDate: string | null; monthlyAmount: number | null; fundAccount: Account; currentAmount: number;
  outlook: { shortfallNow: number; monthsLeft: number | null; projected: number | null; projectedShortfall: number | null };
};
type ContractView = RentContract & {
  reservePlan: ReservePlan | null;
  payments: Array<RentPayment & { fundAccount: Account }>;
  paymentSummary: { contractAmount: number; paid: number; ledgerPaid: number; preLedgerPaid: number; remaining: number };
  usage: Array<{ month: string; status: RentUsageStatus; amount: number | null; transactionIds: number[] }>;
};
type EligibleAccount = { id: number; displayName: string };

const money = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value))} ₫`;
const emptyForm = { name: "", lessorName: "", periodStart: "", periodEnd: "", annualAmount: "", monthlyExpenseAmount: "", status: "planned", termsStatus: "provisional", paymentMethod: "", paymentDueDate: "", paymentTermsNote: "", memo: "" };
type ContractForm = typeof emptyForm;
const formOf = (contract: RentContract): ContractForm => ({
  name: contract.name, lessorName: contract.lessor_name ?? "", periodStart: contract.period_start, periodEnd: contract.period_end,
  annualAmount: String(Number(contract.annual_amount)), monthlyExpenseAmount: contract.monthly_expense_amount == null ? "" : String(Number(contract.monthly_expense_amount)),
  status: contract.status, termsStatus: contract.terms_status, paymentMethod: contract.payment_method ?? "", paymentDueDate: contract.payment_due_date ?? "",
  paymentTermsNote: contract.payment_terms_note ?? "", memo: contract.memo ?? "",
});

// 임대료 관리: contract terms, actual payments (ledger links + pre-ledger evidence),
// monthly usage and the next-lease reserve. Never books a ledger transaction.
export default function RentManagementPanel({ lang, eligibleAccounts }: { lang: "ko" | "vi"; eligibleAccounts: EligibleAccount[] }) {
  const copy = rentText[lang];
  const [contracts, setContracts] = useState<ContractView[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/ledger/rent-contracts", { cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) throw new Error(body?.code ?? "LOAD_FAILED");
    setContracts(body.contracts);
  }, []);
  useEffect(() => { void load().catch(() => setError(copy.loadFailed)); }, [load, copy.loadFailed]);

  async function post(body: Record<string, unknown>) {
    setWorking(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/ledger/rent-contracts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.code ?? "SAVE_FAILED");
      setMessage(copy.saved); await load(); return true;
    } catch (cause) { setError(copy.saveFailed((cause as Error).message)); return false; }
    finally { setWorking(false); }
  }
  const saveContract = (contract: RentContract | null, form: ContractForm) => post({
    action: "save", contractId: contract?.id ?? null,
    contract: {
      ...form, annualAmount: Number(form.annualAmount), monthlyExpenseAmount: form.monthlyExpenseAmount ? Number(form.monthlyExpenseAmount) : null,
      // Links are kept as they are; they are set by the reviewed seed, not edited here.
      recurringPlanId: contract?.recurring_plan_id ?? null, reservePlanId: contract?.reserve_plan_id ?? null,
    },
  });

  return <section className={`${styles.card} ${styles.rentPanel}`} aria-label={copy.title}>
    <div className={styles.cardHeader}><div><h2>{copy.title}</h2></div><button type="button" className={`${styles.secondarySmall} ${styles.reserveAddButton}`} aria-expanded={adding} onClick={() => setAdding(value => !value)}>{adding ? copy.closeEditor : copy.addContract}</button></div>
    <p className={`${styles.infoPanel} ${styles.compactInfo}`}>ℹ️ {copy.intro}</p>
    {message ? <p role="status" className={styles.notice}>{message}</p> : null}{error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {adding ? <ContractEditor copy={copy} initial={emptyForm} working={working} onSave={form => saveContract(null, form).then(ok => { if (ok) setAdding(false); })} /> : null}
    {contracts === null ? <p className={styles.compactEmpty}>…</p> : !contracts.length ? <p className={styles.compactEmpty}>{copy.noContract}</p>
      : contracts.map(contract => <ContractCard key={contract.id} contract={contract} copy={copy} working={working} eligibleAccounts={eligibleAccounts} onSave={form => saveContract(contract, form)} onPost={post} />)}
  </section>;
}

function ContractCard({ contract, copy, working, eligibleAccounts, onSave, onPost }: {
  contract: ContractView; copy: RentCopy; working: boolean; eligibleAccounts: EligibleAccount[];
  onSave: (form: ContractForm) => Promise<boolean>; onPost: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState<"edit" | "payment" | null>(null);
  const [transactionId, setTransactionId] = useState("");
  const [pre, setPre] = useState({ reference: "", paidOn: "", amount: "", fundAccountId: "" });
  const summary = contract.paymentSummary;
  const reserve = contract.reservePlan;
  return <article className={styles.reserveCard} data-rent-contract-id={contract.id}>
    <header className={styles.reserveHeader}><div>
      <span className={styles.overline}>{copy.status[contract.status]}</span>
      <h3>{contract.name}</h3>
      <div className={styles.reserveMeta}><span>📅 {contract.period_start} ~ {contract.period_end}</span><span className={contract.terms_status === "confirmed" ? styles.statusActive : styles.statusInactive}>{copy.terms[contract.terms_status]}</span></div>
    </div></header>
    <div className={styles.reserveSummary}>
      <div><span>{copy.annualAmount}</span><strong>{money(summary.contractAmount)}</strong></div>
      {contract.monthly_expense_amount != null ? <div><span>{copy.monthlyExpense}</span><strong>{money(Number(contract.monthly_expense_amount))}</strong></div> : null}
      <div><span>{copy.paymentMethod} · {copy.dueDate}</span><strong>{contract.payment_method ? copy.method[contract.payment_method] : copy.notConfirmed} · {contract.payment_due_date ?? copy.notConfirmed}</strong></div>
      <div className={styles.currentReserveRow}><span>{copy.paid}</span><strong>{money(summary.paid)}</strong></div>
      <div><span>{copy.remaining}</span><strong>{money(summary.remaining)}</strong></div>
    </div>
    {contract.payments.length ? <div className={styles.historyGroup}><strong>{copy.payments}</strong><div className={styles.historyList}>
      {contract.payments.map(payment => <div className={styles.historyRow} key={payment.id} data-rent-payment-source={payment.source}>
        <div><strong>{payment.paid_on}</strong><span>{payment.source === "ledger" && payment.payment_transaction_id
          ? <Link href={`/admin/ledger/entries?month=${payment.paid_on.slice(0, 7)}&transactionId=${payment.payment_transaction_id}`}>{copy.ledgerPayment(payment.payment_transaction_id)}</Link>
          : `${copy.preLedgerPayment} · ${payment.pre_ledger_reference ?? ""}`}</span>
          {payment.source === "pre_ledger" ? <span>{copy.preLedgerNote}</span> : null}</div>
        <div><strong>{money(Number(payment.amount))}</strong><span>{payment.fundAccount?.displayName ?? ""}</span></div>
      </div>)}
    </div></div> : <p className={styles.compactEmpty}>{copy.noPayments}</p>}
    {contract.usage.length && contract.status !== "planned" ? <div className={styles.historyGroup}><strong>{copy.usage}</strong>
      <div className={styles.rentUsageGrid}>{contract.usage.map(row => <div key={row.month} className={`${styles.rentUsageCell} ${styles[`rentUsage_${row.status}`] ?? ""}`} data-rent-usage-status={row.status}>
        <b>{row.month}</b>
        <span>{copy.usageStatus[row.status]}</span>
        {row.status === "recognized" && row.transactionIds[0] ? <Link href={`/admin/ledger/entries?month=${row.month}&transactionId=${row.transactionIds[0]}`}>{row.amount === null ? "" : money(row.amount)}</Link> : <span>{row.amount === null ? "" : money(row.amount)}</span>}
      </div>)}</div>
      <p className={styles.mutedHelp}>{copy.usageNote}</p>
    </div> : null}
    {reserve ? <div className={styles.historyGroup}><strong>{copy.reserve}</strong><div className={styles.reserveSummary}>
      <div className={styles.currentReserveRow}><span>{copy.reserveCurrent}</span><strong>{money(reserve.currentAmount)}</strong></div>
      <div><span>{copy.reserveTarget(money(reserve.targetAmount), reserve.targetDate ?? copy.notConfirmed)}</span><strong>{reserve.monthlyAmount === null ? "" : copy.reserveMonthly(money(reserve.monthlyAmount))}</strong></div>
      {reserve.outlook.monthsLeft !== null && reserve.outlook.projected !== null ? <div><span>{copy.reserveOutlook(reserve.outlook.monthsLeft, money(reserve.outlook.projected))}</span><strong>{reserve.outlook.projectedShortfall ? "⚠️" : "✓"}</strong></div> : null}
    </div>{reserve.outlook.projectedShortfall ? <p className={`${styles.warningPanel} ${styles.compactDetailInfo}`}>{copy.reserveShortfall(money(reserve.outlook.projectedShortfall))}</p> : <p className={`${styles.infoPanel} ${styles.compactDetailInfo}`}>{copy.reserveOnTrack}</p>}</div> : null}
    <div className={styles.reserveNav}>{([["edit", copy.editContract], ["payment", copy.linkPayment]] as const).map(([value, label]) => <button type="button" key={value} className={open === value ? styles.reserveNavActive : undefined} aria-expanded={open === value} onClick={() => setOpen(current => current === value ? null : value)}><span>{label}</span><span aria-hidden>{open === value ? "⌃" : "›"}</span></button>)}</div>
    {open === "edit" ? <ContractEditor copy={copy} initial={formOf(contract)} working={working} onSave={form => onSave(form).then(ok => { if (ok) setOpen(null); })} /> : null}
    {open === "payment" ? <section className={styles.detailBody}>
      <div className={styles.reserveFormGrid}><label className={styles.reserveFullField}>{copy.transactionId}<input className={styles.input} inputMode="numeric" value={transactionId} onChange={event => setTransactionId(event.target.value.replace(/\D/g, ""))} /></label></div>
      <button className={`${styles.secondary} ${styles.detailAction}`} disabled={working || !transactionId} onClick={() => void onPost({ action: "link", contractId: contract.id, transactionId: Number(transactionId) }).then(ok => { if (ok) setTransactionId(""); })}>{copy.linkPayment}</button>
      <h4>{copy.recordPreLedger}</h4>
      <p className={`${styles.infoPanel} ${styles.compactDetailInfo}`}>{copy.preLedgerNote}</p>
      <div className={styles.reserveFormGrid}>
        <label className={styles.reserveFullField}>{copy.reference}<input className={styles.input} value={pre.reference} onChange={event => setPre({ ...pre, reference: event.target.value })} /></label>
        <label>{copy.paidOn}<input className={styles.input} type="date" value={pre.paidOn} onChange={event => setPre({ ...pre, paidOn: event.target.value })} /></label>
        <label>{copy.amount}<input className={styles.input} inputMode="decimal" value={pre.amount} onChange={event => setPre({ ...pre, amount: event.target.value.replace(/[^\d.]/g, "") })} /></label>
        <label className={styles.reserveFullField}>{copy.account}<select className={styles.input} value={pre.fundAccountId} onChange={event => setPre({ ...pre, fundAccountId: event.target.value })}><option value="" />{eligibleAccounts.map(account => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label>
      </div>
      <button className={`${styles.secondary} ${styles.detailAction}`} disabled={working || !pre.reference || !pre.paidOn || !pre.amount} onClick={() => void onPost({ action: "pre_ledger", contractId: contract.id, reference: pre.reference, paidOn: pre.paidOn, amount: Number(pre.amount), fundAccountId: pre.fundAccountId ? Number(pre.fundAccountId) : null }).then(ok => { if (ok) setPre({ reference: "", paidOn: "", amount: "", fundAccountId: "" }); })}>{copy.recordPreLedger}</button>
    </section> : null}
  </article>;
}

function ContractEditor({ copy, initial, working, onSave }: { copy: RentCopy; initial: ContractForm; working: boolean; onSave: (form: ContractForm) => void }) {
  const [form, setForm] = useState(initial);
  const field = (key: keyof ContractForm) => ({ value: form[key], onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }) });
  return <section className={styles.detailBody}>
    <div className={styles.reserveFormGrid}>
      <label className={styles.reserveFullField}>{copy.name}<input className={styles.input} {...field("name")} /></label>
      <label className={styles.reserveFullField}>{copy.lessor}<input className={styles.input} {...field("lessorName")} /></label>
      <label>{copy.start}<input className={styles.input} type="date" {...field("periodStart")} /></label>
      <label>{copy.end}<input className={styles.input} type="date" {...field("periodEnd")} /></label>
      <label>{copy.annualAmount}<input className={styles.input} inputMode="decimal" {...field("annualAmount")} /></label>
      <label>{copy.monthlyExpense}<input className={styles.input} inputMode="decimal" {...field("monthlyExpenseAmount")} /></label>
      <label>{copy.contractStatus}<select className={styles.input} {...field("status")}>{Object.entries(copy.status).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>{copy.termsStatus}<select className={styles.input} {...field("termsStatus")}>{Object.entries(copy.terms).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>{copy.paymentMethod}<select className={styles.input} {...field("paymentMethod")}><option value="">{copy.notConfirmed}</option>{Object.entries(copy.method).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>{copy.dueDate}<input className={styles.input} type="date" {...field("paymentDueDate")} /></label>
      <label className={styles.reserveFullField}>{copy.termsNote}<input className={styles.input} {...field("paymentTermsNote")} /></label>
      <label className={styles.reserveFullField}>{copy.memo}<input className={styles.input} {...field("memo")} /></label>
    </div>
    <button className={`${styles.primary} ${styles.detailAction}`} disabled={working || !form.name || !form.periodStart || !form.periodEnd || !form.annualAmount} onClick={() => onSave(form)}>{copy.save}</button>
  </section>;
}
