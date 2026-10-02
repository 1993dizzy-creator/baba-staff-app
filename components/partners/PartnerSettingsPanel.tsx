"use client";

/* eslint-disable react-hooks/set-state-in-effect -- authenticated API bootstrap. */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarSheet } from "@/components/bar/keeping/KeepingUi";
import PartnerForm, { type FundAccount, type PartnerFormValue, type PartnerSubtype } from "@/components/PartnerForm";
import PartnerSubtypeManager from "@/components/PartnerSubtypeManager";
import { formatInventoryItemCount, type InventoryCategoryGroup } from "@/lib/inventory/category-groups";
import { groupPartnersByTypeAndSubtype } from "@/lib/partners/policy";
import { effectivePartnerEmoji, partnerTypeEmoji } from "@/lib/partners/emoji";
import { formatPartnerPaymentSummary, formatPartnerSubtypeName, partnerText, partnerTypeLabels } from "@/lib/partners/text";
import { PARTNER_SETTINGS_VIEWS, partnerSettingsText, type PartnerSettingsView } from "@/lib/partners/settings-view";
import styles from "@/app/(protected)/admin/partners/partners.module.css";

// One screen for what used to be /admin/partners (Supplier Candidate review +
// new partner) and /admin/partners/info (regular partners). Data comes from the
// same single GET /api/admin/partners both pages used; price history is never
// read here — the partner detail page still loads it lazily on its own tab.

type Alias = { id: number; supplierName: string; status: "pending" | "linked" | "ignored" | "archived"; inventoryCount: number; activeInventoryCount: number; dominantInventoryGroup: InventoryCategoryGroup | null };
type Partner = PartnerFormValue & { partnerSubtype: PartnerSubtype | null; id: number; inventoryCount: number; activeInventoryCount: number; defaultFundAccountCode: string | null; displayTag: string | null };

const ADD_FORM_ID = "partner-add-form";

function PartnerRow({ partner, lang }: { partner: Partner; lang: "ko" | "vi" }) {
  const payment = formatPartnerPaymentSummary(partner, lang);
  return <Link className={`${styles.compactRow} ${styles.partnerInfoRow}`} href={`/admin/partners/${partner.id}`}>
    <span className={styles.rowNameGroup}>
      <strong className={styles.rowName}>{effectivePartnerEmoji(partner.partnerType, partner.partnerSubtype)} {partner.name}</strong>
      {partner.displayTag ? <span className={styles.tagBadge}>{partner.displayTag}</span> : null}
    </span>
    <span className={styles.rowMeta}>{payment} · {formatInventoryItemCount(partner.inventoryCount, partner.activeInventoryCount, lang)}</span>
    <span className={styles.chevron} aria-hidden="true">›</span>
  </Link>;
}

function CandidateRow({ alias, lang }: { alias: Alias; lang: "ko" | "vi" }) {
  return <Link className={styles.compactRow} href={`/admin/partners/candidates/${alias.id}`}><strong className={styles.rowName}>{alias.supplierName}</strong>{alias.dominantInventoryGroup ? <span className={styles.groupBadge}>{alias.dominantInventoryGroup[lang]}</span> : null}<span className={styles.rowMeta}>{formatInventoryItemCount(alias.inventoryCount, alias.activeInventoryCount, lang)}</span><span className={styles.chevron} aria-hidden="true">›</span></Link>;
}

export default function PartnerSettingsPanel({ lang, view, onViewChange }: { lang: "ko" | "vi"; view: PartnerSettingsView; onViewChange: (view: PartnerSettingsView) => void }) {
  const t = partnerText[lang];
  const labels = partnerSettingsText[lang];
  const [partners, setPartners] = useState<Partner[]>([]);
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [fundAccounts, setFundAccounts] = useState<FundAccount[]>([]);
  const [partnerSubtypes, setPartnerSubtypes] = useState<PartnerSubtype[]>([]);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [showSubtypeManager, setShowSubtypeManager] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const subtypeManagerButtonRef = useRef<HTMLButtonElement>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/partners", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code);
    setPartners(body.partners);
    setAliases(body.supplierAliases);
    setFundAccounts(body.fundAccounts);
    setPartnerSubtypes(body.partnerSubtypes);
  }, []);
  useEffect(() => { void load().catch(() => setError(t.loadFailed)); }, [load, t.loadFailed]);

  // 등록대기 = pending Supplier Candidates; 사용중/사용안함 = regular partners by is_active.
  // Ignored/archived candidates are processing history, never "사용안함" partners.
  const pendingAliases = aliases.filter(row => row.status === "pending");
  const ignoredAliases = aliases.filter(row => row.status === "ignored");
  const counts: Record<PartnerSettingsView, number> = {
    pending: pendingAliases.length,
    active: partners.filter(row => row.isActive).length,
    inactive: partners.filter(row => !row.isActive).length,
  };
  // 대분류 -> 중분류(sort_order) -> Partner(name); unclassified always trails its group.
  const groups = useMemo(() => view === "pending" ? [] : groupPartnersByTypeAndSubtype(partners, view === "active", lang, partnerSubtypes), [view, lang, partners, partnerSubtypes]);

  async function create(value: PartnerFormValue) {
    setError("");
    const response = await fetch("/api/admin/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    const body = await response.json();
    if (!response.ok) { setError(body.code === "DUPLICATE_NAME" ? t.duplicate : body.code); return false; }
    setShowAdd(false); await load(); alert(t.saved); return true;
  }

  const candidateRows = showResolved ? ignoredAliases : pendingAliases;
  return <section className={styles.compactPage} aria-label={labels.title}>
    <div className={styles.partnerSettingsHeader}>
      <h2>{labels.title}</h2>
      <button ref={addButtonRef} type="button" className={styles.partnerAddButton} onClick={() => setShowAdd(true)}>{labels.add}</button>
    </div>
    {showAdd ? <BarSheet kind="full" compact title={labels.addTitle} closeLabel={labels.close} saving={addSaving} onClose={() => setShowAdd(false)} returnFocusRef={addButtonRef} footer={<button type="submit" form={ADD_FORM_ID} className={styles.primary} disabled={addSaving} style={{ width: "100%" }}>{addSaving ? t.saving : t.add}</button>}>
      <PartnerForm formId={ADD_FORM_ID} lang={lang} fundAccounts={fundAccounts} partnerSubtypes={partnerSubtypes} submitLabel={t.add} showActive={false} layout="modal" onSavingChange={setAddSaving} onSubmit={create} />
    </BarSheet> : null}
    <div className={styles.infoActions}>
      <button ref={subtypeManagerButtonRef} type="button" onClick={() => setShowSubtypeManager(true)}>
        <span aria-hidden="true">🗂️</span>
        <span>{labels.manageSubtypes}</span>
        <span className={styles.infoActionChevron} aria-hidden="true">›</span>
      </button>
    </div>
    <PartnerSubtypeManager lang={lang} open={showSubtypeManager} partnerSubtypes={partnerSubtypes} onClose={() => setShowSubtypeManager(false)} onReload={load} returnFocusRef={subtypeManagerButtonRef} />
    <div className={styles.compactFilters} role="tablist" aria-label={t.status}>{PARTNER_SETTINGS_VIEWS.map(key => <button role="tab" aria-selected={view === key} className={view === key ? styles.filterActive : ""} key={key} type="button" onClick={() => onViewChange(key)}>{labels[key]} {counts[key]}</button>)}</div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {view === "pending" ? <>
      <section className={styles.compactList}>{candidateRows.map(alias => <CandidateRow alias={alias} lang={lang} key={alias.id} />)}{candidateRows.length === 0 ? <p className={styles.compactEmpty}>{labels.empty}</p> : null}</section>
      <button type="button" className={styles.resolvedToggle} aria-pressed={showResolved} onClick={() => setShowResolved(value => !value)}>{showResolved ? labels.hideResolved : `${labels.showResolved} ${ignoredAliases.length}`}</button>
    </> : groups.length === 0 ? <section className={styles.compactList}><p className={styles.compactEmpty}>{labels.empty}</p></section> : <div className={styles.partnerGroups}>{groups.map(group => <section className={styles.partnerGroup} key={group.type}>
      <header className={styles.partnerGroupHeader} data-partner-type={group.type}>
        <span aria-hidden="true">{partnerTypeEmoji[group.type]}</span>
        <strong>{partnerTypeLabels[group.type][lang]}</strong>
        <span className={styles.partnerGroupCount}>{group.partners.length}</span>
      </header>
      {group.subgroups.map(sub => <div className={styles.subtypeGroup} key={sub.subtype.id}>
        <h3 className={styles.subtypeDivider}>{effectivePartnerEmoji(group.type, sub.subtype)} {formatPartnerSubtypeName(sub.subtype, lang)}</h3>
        <div className={styles.compactList}>{sub.partners.map(partner => <PartnerRow partner={partner} lang={lang} key={partner.id} />)}</div>
      </div>)}
      {group.unclassified.length > 0 ? <div className={styles.subtypeGroup}>
        <h3 className={styles.subtypeDivider}>{partnerTypeEmoji[group.type]} {formatPartnerSubtypeName(null, lang)}</h3>
        <div className={styles.compactList}>{group.unclassified.map(partner => <PartnerRow partner={partner} lang={lang} key={partner.id} />)}</div>
      </div> : null}
    </section>)}</div>}
  </section>;
}
