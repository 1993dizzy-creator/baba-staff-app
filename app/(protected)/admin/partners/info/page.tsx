"use client";

/* eslint-disable react-hooks/set-state-in-effect -- authenticated API bootstrap. */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import Container from "@/components/Container";
import type { PartnerFormValue } from "@/components/PartnerForm";
import { formatInventoryItemCount } from "@/lib/inventory/category-groups";
import { useLanguage } from "@/lib/language-context";
import { groupPartnersByType, type PartnerType } from "@/lib/partners/policy";
import { formatPartnerPaymentPolicy, partnerText, partnerTypeLabels } from "@/lib/partners/text";
import styles from "../partners.module.css";

type Partner = PartnerFormValue & { id: number; inventoryCount: number; activeInventoryCount: number };
type Filter = "active" | "inactive";

const partnerTypeIcons: Record<PartnerType, string> = {
  alcohol: "🍷", beverage: "🥤", food: "🥬", consumable: "🧻",
  equipment: "🧰", service: "🛎️", rent: "🏠", other: "📦",
};

export default function PartnerInfoPage() {
  const { lang } = useLanguage();
  const t = partnerText[lang];
  const [partners, setPartners] = useState<Partner[]>([]);
  const [filter, setFilter] = useState<Filter>("active");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/partners", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code);
    setPartners(body.partners);
  }, []);
  useEffect(() => { void load().catch(() => setError(t.loadFailed)); }, [load, t.loadFailed]);

  const labels = lang === "vi"
    ? { active: "Đang dùng", inactive: "Ngừng dùng", empty: "Không có đối tác phù hợp." }
    : { active: "사용 중", inactive: "사용 안 함", empty: "조건에 맞는 거래처가 없습니다." };
  const counts = { active: partners.filter(row => row.isActive).length, inactive: partners.filter(row => !row.isActive).length };
  const groups = useMemo(() => groupPartnersByType(partners, filter === "active", lang), [filter, lang, partners]);

  return <Container><main className={styles.compactPage}>
    <div className={styles.compactFilters} role="tablist" aria-label={t.status}>{(["active", "inactive"] as Filter[]).map(key => <button role="tab" aria-selected={filter === key} className={filter === key ? styles.filterActive : ""} key={key} type="button" onClick={() => setFilter(key)}>{labels[key]} {counts[key]}</button>)}</div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {groups.length === 0 ? <section className={styles.compactList}><p className={styles.compactEmpty}>{labels.empty}</p></section> : <div className={styles.partnerGroups}>{groups.map(group => <section className={styles.partnerGroup} key={group.type}>
      <header className={styles.partnerGroupHeader} data-partner-type={group.type}>
        <span aria-hidden="true">{partnerTypeIcons[group.type]}</span>
        <strong>{partnerTypeLabels[group.type][lang]}</strong>
        <span className={styles.partnerGroupCount}>{group.partners.length}</span>
      </header>
      <div className={styles.compactList}>{group.partners.map(partner => {
        const payment = formatPartnerPaymentPolicy(partner, lang);
        return <Link className={`${styles.compactRow} ${styles.partnerInfoRow}`} href={`/admin/partners/${partner.id}`} key={partner.id}><strong className={styles.rowName}>{partner.name}</strong><span className={styles.rowMeta}>{payment} · {formatInventoryItemCount(partner.inventoryCount, partner.activeInventoryCount, lang)}</span><span className={styles.chevron} aria-hidden="true">›</span></Link>;
      })}</div>
    </section>)}</div>}
  </main></Container>;
}
