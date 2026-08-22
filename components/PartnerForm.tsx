"use client";

import { useState, type FormEvent } from "react";
import { PARTNER_TYPES, type PartnerType, type PaymentMode } from "@/lib/partners/policy";
import { partnerText, partnerTypeLabels } from "@/lib/partners/text";
import styles from "@/app/(protected)/admin/partners/partners.module.css";

export type PartnerFormValue = { name: string; partnerType: PartnerType; paymentMode: PaymentMode; defaultPaymentTermDays: number | null; contactName: string | null; phone: string | null; memo: string | null; isActive: boolean; ledgerPartyId: number | null };
type LedgerParty = { id: number; name: string; isActive: boolean };
type Props = {
  lang: "ko" | "vi";
  initial?: PartnerFormValue;
  ledgerParties: LedgerParty[];
  submitLabel?: string;
  showLedgerParty?: boolean;
  showActive?: boolean;
  layout?: "modal" | "page";
  onSubmit: (value: PartnerFormValue) => Promise<boolean>;
};

export default function PartnerForm({ lang, initial, ledgerParties, submitLabel, showLedgerParty = true, showActive = true, layout = "page", onSubmit }: Props) {
  const t = partnerText[lang];
  const sectionLabels = lang === "vi"
    ? { basic: "Thông tin cơ bản", payment: "Hình thức thanh toán", contact: "Liên hệ", memo: "Ghi chú", other: "Khác", ledger: "Liên kết sổ sách" }
    : { basic: "기본 정보", payment: "결제 방식", contact: "연락처", memo: "메모", other: "기타", ledger: "장부 연동" };
  const emptyValue: PartnerFormValue = { name: "", partnerType: "other", paymentMode: "immediate", defaultPaymentTermDays: null, contactName: null, phone: null, memo: null, isActive: true, ledgerPartyId: null };
  const [value, setValue] = useState<PartnerFormValue>(initial ?? emptyValue);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) { event.preventDefault(); setSaving(true); try { const ok = await onSubmit(value); if (ok && !initial) setValue(emptyValue); } finally { setSaving(false); } }

  return <form className={`${styles.formSections} ${layout === "modal" ? styles.modalPartnerForm : styles.pagePartnerForm}`} onSubmit={submit}>
    <div className={styles.formBody}>
    <section className={styles.formSection} aria-labelledby="partner-basic-heading">
      <h3 id="partner-basic-heading"><span aria-hidden="true">📋</span><span>{sectionLabels.basic}</span></h3>
      <div className={`${styles.formGrid} ${styles.basicGrid}`}>
        <label>{t.name} *<input required maxLength={200} value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} /></label>
        <label>{t.type}<select value={value.partnerType} onChange={event => setValue({ ...value, partnerType: event.target.value as PartnerType })}>{PARTNER_TYPES.map(type => <option key={type} value={type}>{partnerTypeLabels[type][lang]}</option>)}</select></label>
      </div>
    </section>
    <section className={styles.formSection} aria-labelledby="partner-payment-heading">
      <h3 id="partner-payment-heading"><span aria-hidden="true">💳</span><span>{sectionLabels.payment}</span></h3>
      <div className={styles.paymentFields}>
        <fieldset><legend className={styles.srOnly}>{t.paymentMode} *</legend><div className={styles.paymentSegments}>{(["immediate", "postpaid"] as PaymentMode[]).map(mode => <label className={value.paymentMode === mode ? styles.paymentSelected : ""} key={mode}><input type="radio" name="paymentMode" checked={value.paymentMode === mode} onChange={() => setValue({ ...value, paymentMode: mode, defaultPaymentTermDays: mode === "immediate" ? null : value.defaultPaymentTermDays ?? 30 })} />{t[mode]}</label>)}</div></fieldset>
      </div>
    </section>
    <section className={styles.formSection} aria-labelledby="partner-contact-heading">
      <h3 id="partner-contact-heading"><span aria-hidden="true">☎️</span><span>{sectionLabels.contact}</span></h3>
      <div className={styles.formGrid}>
        <label>{t.contact}<input maxLength={120} value={value.contactName ?? ""} onChange={event => setValue({ ...value, contactName: event.target.value || null })} /></label>
        <label>{t.phone}<input type="tel" maxLength={80} value={value.phone ?? ""} onChange={event => setValue({ ...value, phone: event.target.value || null })} /></label>
      </div>
    </section>
    <section className={styles.formSection} aria-labelledby="partner-other-heading">
      <h3 id="partner-other-heading"><span aria-hidden="true">📝</span><span>{showActive ? sectionLabels.other : sectionLabels.memo}</span></h3>
      <div className={styles.formGrid}>
        <label className={styles.full}>{showActive ? t.memo : <span className={styles.srOnly}>{t.memo}</span>}<textarea rows={2} value={value.memo ?? ""} onChange={event => setValue({ ...value, memo: event.target.value || null })} /></label>
        {showActive ? <label className={styles.toggle}><input type="checkbox" checked={value.isActive} onChange={event => setValue({ ...value, isActive: event.target.checked })} />{value.isActive ? t.active : t.inactive}</label> : null}
      </div>
    </section>
    {showLedgerParty ? <section className={styles.formSection} aria-labelledby="partner-ledger-heading">
      <h3 id="partner-ledger-heading"><span aria-hidden="true">📒</span><span>{sectionLabels.ledger}</span></h3>
      <div className={styles.formGrid}><label>{t.ledger}<select value={value.ledgerPartyId ?? ""} onChange={event => setValue({ ...value, ledgerPartyId: event.target.value ? Number(event.target.value) : null })}><option value="">{t.noLedger}</option>{ledgerParties.filter(row => row.isActive || row.id === value.ledgerPartyId).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label></div>
    </section> : null}
    </div>
    <footer className={styles.formFooter}><button className={styles.primary} disabled={saving}>{saving ? t.saving : submitLabel ?? t.save}</button></footer>
  </form>;
}
