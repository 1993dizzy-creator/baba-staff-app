"use client";

/* eslint-disable react-hooks/set-state-in-effect -- authenticated API bootstrap. */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import Container from "@/components/Container";
import type { PartnerFormValue } from "@/components/PartnerForm";
import { formatInventoryItemCount, type InventoryCategoryGroup } from "@/lib/inventory/category-groups";
import { useLanguage } from "@/lib/language-context";
import { formatPartnerPaymentPolicy, partnerText } from "@/lib/partners/text";
import styles from "../partners.module.css";

type Partner = PartnerFormValue & { id: number; inventoryCount: number; activeInventoryCount: number; dominantInventoryGroup: InventoryCategoryGroup | null };
type Filter = "active" | "inactive";

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
  const rows = useMemo(() => partners.filter(row => row.isActive === (filter === "active")), [partners, filter]);

  return <Container><main className={styles.compactPage}>
    <div className={styles.compactFilters} role="tablist" aria-label={t.status}>{(["active", "inactive"] as Filter[]).map(key => <button role="tab" aria-selected={filter === key} className={filter === key ? styles.filterActive : ""} key={key} type="button" onClick={() => setFilter(key)}>{labels[key]} {counts[key]}</button>)}</div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <section className={styles.compactList}>{rows.map(partner => {
      const payment = formatPartnerPaymentPolicy(partner, lang);
      return <Link className={styles.compactRow} href={`/admin/partners/${partner.id}`} key={partner.id}><strong className={styles.rowName}>{partner.name}</strong>{partner.dominantInventoryGroup ? <span className={styles.groupBadge}>{partner.dominantInventoryGroup[lang]}</span> : null}<span className={styles.rowMeta}>{payment} · {formatInventoryItemCount(partner.inventoryCount, partner.activeInventoryCount, lang)}</span><span className={styles.chevron} aria-hidden="true">›</span></Link>;
    })}{rows.length === 0 ? <p className={styles.compactEmpty}>{labels.empty}</p> : null}</section>
  </main></Container>;
}
