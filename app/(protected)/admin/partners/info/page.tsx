"use client";

/* eslint-disable react-hooks/set-state-in-effect -- authenticated API bootstrap. */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import Container from "@/components/Container";
import type { PartnerFormValue, PartnerSubtype } from "@/components/PartnerForm";
import { formatInventoryItemCount } from "@/lib/inventory/category-groups";
import { useLanguage } from "@/lib/language-context";
import { groupPartnersByTypeAndSubtype, type PartnerType } from "@/lib/partners/policy";
import { formatPartnerPaymentSummary, formatPartnerSubtypeName, partnerText, partnerTypeLabels } from "@/lib/partners/text";
import styles from "../partners.module.css";

type Partner = PartnerFormValue & { id: number; inventoryCount: number; activeInventoryCount: number; defaultFundAccountCode: string | null; displayTag: string | null };
type Filter = "active" | "inactive";

const partnerTypeIcons: Record<PartnerType, string> = {
  alcohol: "🍷", beverage: "🥤", food: "🥬", consumable: "🧻",
  equipment: "🧰", service: "🛎️", rent: "🏠", other: "📦",
};

function PartnerRow({ partner, lang }: { partner: Partner; lang: "ko" | "vi" }) {
  const payment = formatPartnerPaymentSummary(partner, lang);
  return <Link className={`${styles.compactRow} ${styles.partnerInfoRow}`} href={`/admin/partners/${partner.id}`}>
    <span className={styles.rowNameGroup}>
      <strong className={styles.rowName}>{partner.name}</strong>
      {partner.displayTag ? <span className={styles.tagBadge}>{partner.displayTag}</span> : null}
    </span>
    <span className={styles.rowMeta}>{payment} · {formatInventoryItemCount(partner.inventoryCount, partner.activeInventoryCount, lang)}</span>
    <span className={styles.chevron} aria-hidden="true">›</span>
  </Link>;
}

export default function PartnerInfoPage() {
  const { lang } = useLanguage();
  const t = partnerText[lang];
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerSubtypes, setPartnerSubtypes] = useState<PartnerSubtype[]>([]);
  const [filter, setFilter] = useState<Filter>("active");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/partners", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code);
    setPartners(body.partners);
    setPartnerSubtypes(body.partnerSubtypes);
  }, []);
  useEffect(() => { void load().catch(() => setError(t.loadFailed)); }, [load, t.loadFailed]);

  const labels = lang === "vi"
    ? { active: "Đang dùng", inactive: "Ngừng dùng", empty: "Không có đối tác phù hợp." }
    : { active: "사용 중", inactive: "사용 안 함", empty: "조건에 맞는 거래처가 없습니다." };
  const counts = { active: partners.filter(row => row.isActive).length, inactive: partners.filter(row => !row.isActive).length };
  // 대분류 -> 중분류(sort_order) -> Partner(name); unclassified always trails its group.
  const groups = useMemo(() => groupPartnersByTypeAndSubtype(partners, filter === "active", lang, partnerSubtypes), [filter, lang, partners, partnerSubtypes]);

  return <Container noPaddingTop><main className={styles.compactPage}>
    <div className={styles.compactFilters} role="tablist" aria-label={t.status}>{(["active", "inactive"] as Filter[]).map(key => <button role="tab" aria-selected={filter === key} className={filter === key ? styles.filterActive : ""} key={key} type="button" onClick={() => setFilter(key)}>{labels[key]} {counts[key]}</button>)}</div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {groups.length === 0 ? <section className={styles.compactList}><p className={styles.compactEmpty}>{labels.empty}</p></section> : <div className={styles.partnerGroups}>{groups.map(group => <section className={styles.partnerGroup} key={group.type}>
      <header className={styles.partnerGroupHeader} data-partner-type={group.type}>
        <span aria-hidden="true">{partnerTypeIcons[group.type]}</span>
        <strong>{partnerTypeLabels[group.type][lang]}</strong>
        <span className={styles.partnerGroupCount}>{group.partners.length}</span>
      </header>
      {group.subgroups.map(sub => <div className={styles.subtypeGroup} key={sub.subtype.id}>
        <h3 className={styles.subtypeDivider}>{formatPartnerSubtypeName(sub.subtype, lang)}</h3>
        <div className={styles.compactList}>{sub.partners.map(partner => <PartnerRow partner={partner} lang={lang} key={partner.id} />)}</div>
      </div>)}
      {group.unclassified.length > 0 ? <div className={styles.subtypeGroup}>
        <h3 className={styles.subtypeDivider}>{formatPartnerSubtypeName(null, lang)}</h3>
        <div className={styles.compactList}>{group.unclassified.map(partner => <PartnerRow partner={partner} lang={lang} key={partner.id} />)}</div>
      </div> : null}
    </section>)}</div>}
  </main></Container>;
}
