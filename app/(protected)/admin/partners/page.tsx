"use client";

/* eslint-disable react-hooks/set-state-in-effect -- authenticated API bootstrap. */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import Container from "@/components/Container";
import PartnerForm, { type PartnerFormValue } from "@/components/PartnerForm";
import { formatInventoryItemCount, type InventoryCategoryGroup } from "@/lib/inventory/category-groups";
import { useLanguage } from "@/lib/language-context";
import { partnerText } from "@/lib/partners/text";
import { ui } from "@/lib/styles/ui";
import styles from "./partners.module.css";

type Alias = { id: number; supplierName: string; status: "pending" | "linked" | "ignored"; inventoryCount: number; activeInventoryCount: number; dominantInventoryGroup: InventoryCategoryGroup | null };
type LedgerParty = { id: number; name: string; isActive: boolean };
type Filter = "pending" | "ignored";

export default function PartnerRegistrationPage() {
  const { lang } = useLanguage();
  const t = partnerText[lang];
  const [aliases, setAliases] = useState<Alias[]>([]);
  const [ledgerParties, setLedgerParties] = useState<LedgerParty[]>([]);
  const [filter, setFilter] = useState<Filter>("pending");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const addPopoverRef = useRef<HTMLDetailsElement>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/partners", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code);
    setAliases(body.supplierAliases);
    setLedgerParties(body.ledgerParties);
  }, []);
  useEffect(() => { void load().catch(error => setError(String(error))); }, [load]);

  const labels = lang === "vi"
    ? { pending: "Chờ duyệt", ignored: "Đã bỏ qua", add: "+ Thêm đối tác", filter: "Trạng thái duyệt", empty: "Không có đối tác phù hợp." }
    : { pending: "등록 대기", ignored: "제외", add: "+ 거래처 추가", filter: "검토 상태", empty: "조건에 맞는 거래처가 없습니다." };
  const counts = { pending: aliases.filter(row => row.status === "pending").length, ignored: aliases.filter(row => row.status === "ignored").length };
  const rows = aliases.filter(row => row.status === filter);

  async function create(value: PartnerFormValue) {
    setError(""); setMessage("");
    const response = await fetch("/api/admin/partners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    const body = await response.json();
    if (!response.ok) { setError(body.code === "DUPLICATE_NAME" ? t.duplicate : body.code); return false; }
    setMessage(t.saved); addPopoverRef.current?.removeAttribute("open"); await load(); return true;
  }

  return <Container noPaddingTop><main className={styles.compactPage}>
    <details ref={addPopoverRef} className={styles.addPopover} onKeyDown={event => { if (event.key === "Escape") addPopoverRef.current?.removeAttribute("open"); }}><summary style={{ ...ui.button, width: "100%", padding: "10px 12px" }}>{labels.add}</summary><div className={styles.addForm} role="dialog" aria-modal="true" aria-label={lang === "vi" ? "Thêm đối tác" : "거래처 추가"}><header className={styles.modalHeader}><h2>{lang === "vi" ? "Thêm đối tác" : "거래처 추가"}</h2><button type="button" aria-label={lang === "vi" ? "Đóng" : "닫기"} onClick={() => addPopoverRef.current?.removeAttribute("open")}>×</button></header><PartnerForm lang={lang} ledgerParties={ledgerParties} submitLabel={t.add} showLedgerParty={false} showActive={false} layout="modal" onSubmit={create} /></div></details>
    <div className={styles.compactFilters} role="tablist" aria-label={labels.filter}>{(["pending", "ignored"] as Filter[]).map(key => <button role="tab" aria-selected={filter === key} className={filter === key ? styles.filterActive : ""} key={key} type="button" onClick={() => setFilter(key)}>{labels[key]} {counts[key]}</button>)}</div>
    {message ? <p className={styles.notice} role="status">{message}</p> : null}{error ? <p className={styles.error} role="alert">{error}</p> : null}
    <section className={styles.compactList}>{rows.map(alias => <Link className={styles.compactRow} href={`/admin/partners/candidates/${alias.id}`} key={alias.id}><strong className={styles.rowName}>{alias.supplierName}</strong>{alias.dominantInventoryGroup ? <span className={styles.groupBadge}>{alias.dominantInventoryGroup[lang]}</span> : null}<span className={styles.rowMeta}>{formatInventoryItemCount(alias.inventoryCount, alias.activeInventoryCount, lang)}</span><span className={styles.chevron} aria-hidden="true">›</span></Link>)}{rows.length === 0 ? <p className={styles.compactEmpty}>{labels.empty}</p> : null}</section>
  </main></Container>;
}
