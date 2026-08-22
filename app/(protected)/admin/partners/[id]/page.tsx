"use client";

/* eslint-disable react-hooks/set-state-in-effect -- route-param API loading is initiated by the effect. */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Container from "@/components/Container";
import PartnerForm, { type PartnerFormValue } from "@/components/PartnerForm";
import { useLanguage } from "@/lib/language-context";
import { partnerText } from "@/lib/partners/text";
import styles from "../partners.module.css";

type Partner = PartnerFormValue & { id: number };
type LedgerParty = { id: number; name: string; isActive: boolean };
type LinkedInventory = { id: number; itemName: string | null; itemNameVi: string | null; part: string | null; category: string | null; categoryVi: string | null; purchasePrice: number | string | null; isActive: boolean; rawSupplier: string | null };

export default function PartnerDetailPage() {
  const params = useParams<{ id: string }>(); const { lang } = useLanguage(); const t = partnerText[lang];
  const [partner, setPartner] = useState<Partner | null>(null); const [ledgerParties, setLedgerParties] = useState<LedgerParty[]>([]); const [linkedInventory, setLinkedInventory] = useState<LinkedInventory[]>([]); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const load = useCallback(async () => { const response = await fetch(`/api/admin/partners/${params.id}`, { cache: "no-store" }); const body = await response.json(); if (!response.ok) throw new Error(body.code); setPartner({ ...body.partner, ledgerPartyId: body.partner.ledgerParty?.id ?? null }); setLedgerParties(body.ledgerParties); setLinkedInventory(body.linkedInventory); }, [params.id]);
  useEffect(() => { void load().catch(() => setError(t.loadFailed)); }, [load, t.loadFailed]);
  async function update(value: PartnerFormValue) { setError(""); setMessage(""); const response = await fetch(`/api/admin/partners/${params.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }); const body = await response.json(); if (!response.ok) { setError(body.code === "DUPLICATE_NAME" ? t.duplicate : body.code); return false; } setMessage(t.saved); await load(); return true; }
  return <Container><main className={styles.page}><Link className={styles.backLink} href="/admin/partners/info">← {lang === "vi" ? "Thông tin" : "정보"}</Link><header className={styles.detailTop}><h1>{partner?.name ?? t.title}</h1></header>{message ? <p className={styles.notice} role="status">{message}</p> : null}{error ? <p className={styles.error} role="alert">{error}</p> : null}{partner ? <section className={styles.panel}><h2>{t.edit}</h2><PartnerForm key={`${partner.id}-${partner.name}-${partner.isActive}`} lang={lang} initial={partner} ledgerParties={ledgerParties} onSubmit={update} /></section> : null}<section className={styles.panel}><h2>{t.supply} {linkedInventory.length}</h2>{linkedInventory.length === 0 ? <p className={styles.muted}>{t.noSupply}</p> : <div className={styles.inventoryList}>{linkedInventory.map(item => <article key={item.id}><div><strong>{lang === "vi" ? item.itemNameVi || item.itemName : item.itemName || item.itemNameVi}</strong><span>{item.part || "-"} · {lang === "vi" ? item.categoryVi || item.category : item.category || item.categoryVi || "-"}</span></div><div><strong>{item.purchasePrice === null ? "-" : `${new Intl.NumberFormat("vi-VN").format(Number(item.purchasePrice))} ₫`}</strong><span>{item.isActive ? t.active : t.inactive}</span></div></article>)}</div>}</section></main></Container>;
}
