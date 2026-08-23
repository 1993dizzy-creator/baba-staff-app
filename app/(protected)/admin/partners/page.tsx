"use client";

/* eslint-disable react-hooks/set-state-in-effect -- authenticated API bootstrap. */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import Container from "@/components/Container";
import { BarSheet } from "@/components/bar/keeping/KeepingUi";
import PartnerForm, { type FundAccount, type PartnerFormValue, type PartnerSubtype } from "@/components/PartnerForm";
import PartnerSubtypeManager from "@/components/PartnerSubtypeManager";
import { formatInventoryItemCount, type InventoryCategoryGroup } from "@/lib/inventory/category-groups";
import { useLanguage } from "@/lib/language-context";
import { partnerText } from "@/lib/partners/text";
import { ui } from "@/lib/styles/ui";
import styles from "./partners.module.css";

type Alias = { id: number; supplierName: string; status: "pending" | "linked" | "ignored" | "archived"; inventoryCount: number; activeInventoryCount: number; dominantInventoryGroup: InventoryCategoryGroup | null };
type Filter = "pending" | "ignored";

const ADD_FORM_ID = "partner-add-form";

export default function PartnerRegistrationPage() {
  const { lang } = useLanguage();
  const t = partnerText[lang];
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [fundAccounts, setFundAccounts] = useState<FundAccount[]>([]);
  const [partnerSubtypes, setPartnerSubtypes] = useState<PartnerSubtype[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [showSubtypeManager, setShowSubtypeManager] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const subtypeManagerButtonRef = useRef<HTMLButtonElement>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/partners", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code);
    setAliases(body.supplierAliases);
    setFundAccounts(body.fundAccounts);
    setPartnerSubtypes(body.partnerSubtypes);
  }, []);
  useEffect(() => { void load().catch(error => setError(String(error))); }, [load]);

  const labels = lang === "vi"
    ? { pending: "Chờ duyệt", ignored: "Đã bỏ qua", add: "+ Thêm đối tác", addTitle: "Thêm đối tác", close: "Đóng", filter: "Trạng thái duyệt", empty: "Không có đối tác phù hợp.", manageSubtypes: "Quản lý danh mục phụ" }
    : { pending: "등록 대기", ignored: "제외", add: "+ 거래처 추가", addTitle: "거래처 추가", close: "닫기", filter: "검토 상태", empty: "조건에 맞는 거래처가 없습니다.", manageSubtypes: "중분류 관리" };
  const counts = { pending: aliases.filter(row => row.status === "pending").length, ignored: aliases.filter(row => row.status === "ignored").length };
  const rows = aliases.filter(row => row.status === filter);

  async function create(value: PartnerFormValue) {
    setError(""); setMessage("");
    const response = await fetch("/api/admin/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    const body = await response.json();
    if (!response.ok) { setError(body.code === "DUPLICATE_NAME" ? t.duplicate : body.code); return false; }
    setMessage(t.saved); setShowAdd(false); await load(); return true;
  }

  return <Container noPaddingTop><main className={styles.compactPage}>
    <div style={{ display: "flex", gap: 8 }}>
      <button ref={addButtonRef} type="button" style={{ ...ui.button, flex: 1, padding: "10px 12px" }} onClick={() => setShowAdd(true)}>{labels.add}</button>
      <button ref={subtypeManagerButtonRef} type="button" style={{ ...ui.button, background: "#fff", color: "#374151", border: "1px solid #d1d5db", padding: "10px 12px" }} onClick={() => setShowSubtypeManager(true)}>{labels.manageSubtypes}</button>
    </div>
    {showAdd ? <BarSheet kind="full" compact title={labels.addTitle} closeLabel={labels.close} saving={addSaving} onClose={() => setShowAdd(false)} returnFocusRef={addButtonRef} footer={<button type="submit" form={ADD_FORM_ID} className={styles.primary} disabled={addSaving} style={{ width: "100%" }}>{addSaving ? t.saving : t.add}</button>}>
      <PartnerForm formId={ADD_FORM_ID} lang={lang} fundAccounts={fundAccounts} partnerSubtypes={partnerSubtypes} submitLabel={t.add} showActive={false} layout="modal" onSavingChange={setAddSaving} onSubmit={create} />
    </BarSheet> : null}
    <PartnerSubtypeManager lang={lang} open={showSubtypeManager} partnerSubtypes={partnerSubtypes} onClose={() => setShowSubtypeManager(false)} onReload={load} returnFocusRef={subtypeManagerButtonRef} />
    <div className={styles.compactFilters} role="tablist" aria-label={labels.filter}>{(["pending", "ignored"] as Filter[]).map(key => <button role="tab" aria-selected={filter === key} className={filter === key ? styles.filterActive : ""} key={key} type="button" onClick={() => setFilter(key)}>{labels[key]} {counts[key]}</button>)}</div>
    {message ? <p className={styles.notice} role="status">{message}</p> : null}{error ? <p className={styles.error} role="alert">{error}</p> : null}
    <section className={styles.compactList}>{rows.map(alias => <Link className={styles.compactRow} href={`/admin/partners/candidates/${alias.id}`} key={alias.id}><strong className={styles.rowName}>{alias.supplierName}</strong>{alias.dominantInventoryGroup ? <span className={styles.groupBadge}>{alias.dominantInventoryGroup[lang]}</span> : null}<span className={styles.rowMeta}>{formatInventoryItemCount(alias.inventoryCount, alias.activeInventoryCount, lang)}</span><span className={styles.chevron} aria-hidden="true">›</span></Link>)}{rows.length === 0 ? <p className={styles.compactEmpty}>{labels.empty}</p> : null}</section>
  </main></Container>;
}
