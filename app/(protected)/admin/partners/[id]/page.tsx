"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Container from "@/components/Container";
import { BarSection, keepingFormCardStyle, keepingInputStyle, primaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import PartnerForm, { type FundAccount, type PartnerFormValue, type PartnerSubtype } from "@/components/PartnerForm";
import { useLanguage } from "@/lib/language-context";
import { partnerText } from "@/lib/partners/text";
import type { PartnerPriceChange } from "@/lib/partners/price-changes";
import styles from "../partners.module.css";

type Partner = PartnerFormValue & { id: number; displayTag: string | null; partnerSubtype: { nameKo: string | null; nameVi: string | null } | null };
type LinkedInventory = { id: number; itemName: string | null; itemNameVi: string | null; part: string | null; category: string | null; categoryVi: string | null; purchasePrice: number | string | null; isActive: boolean; rawSupplier: string | null };
type DetailTab = "items" | "priceChanges";
type PriceChangesStatus = "idle" | "loading" | "loaded" | "error";

export default function PartnerDetailPage() {
  const params = useParams<{ id: string }>(); const { lang } = useLanguage(); const t = partnerText[lang];
  const [partner, setPartner] = useState<Partner | null>(null); const [fundAccounts, setFundAccounts] = useState<FundAccount[]>([]); const [partnerSubtypes, setPartnerSubtypes] = useState<PartnerSubtype[]>([]); const [linkedInventory, setLinkedInventory] = useState<LinkedInventory[]>([]); const [error, setError] = useState("");
  const [priceChanges, setPriceChanges] = useState<PartnerPriceChange[]>([]); const [priceChangesStatus, setPriceChangesStatus] = useState<PriceChangesStatus>("idle"); const [detailTab, setDetailTab] = useState<DetailTab>("items");
  const [tagInput, setTagInput] = useState(""); const [tagSaving, setTagSaving] = useState(false); const [tagError, setTagError] = useState("");
  // ledgerPartyId is preserved from the API response (backend bridge field) even though
  // the form no longer renders a control for it, so an existing link is never dropped on save.
  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/partners/${params.id}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code);
    setPartner({ ...body.partner, ledgerPartyId: body.partner.ledgerParty?.id ?? null });
    setFundAccounts(body.fundAccounts);
    setPartnerSubtypes(body.partnerSubtypes);
    setLinkedInventory(body.linkedInventory);
    setTagInput(body.partner.displayTag ?? "");
  }, [params.id]);
  useEffect(() => { void load().catch(() => setError(t.loadFailed)); }, [load, t.loadFailed]);
  async function update(value: PartnerFormValue) { setError(""); const response = await fetch(`/api/admin/partners/${params.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }); const body = await response.json(); if (!response.ok) { setError(body.code === "DUPLICATE_NAME" ? t.duplicate : body.code); return false; } await load(); alert(t.saved); return true; }

  async function openPriceChanges() {
    setDetailTab("priceChanges");
    if (priceChangesStatus === "loading" || priceChangesStatus === "loaded") return;
    setPriceChangesStatus("loading");
    try {
      const response = await fetch(`/api/admin/partners/${params.id}/price-changes`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code);
      setPriceChanges(body.priceChanges);
      setPriceChangesStatus("loaded");
    } catch {
      setPriceChangesStatus("error");
    }
  }

  // Tag is saved through its own endpoint, never through the main partner update above,
  // so editing a tag can never overwrite payment/contact/settlement fields.
  async function saveTag() {
    setTagSaving(true); setTagError("");
    try {
      const nextTag = tagInput.trim() || null;
      const response = await fetch(`/api/admin/partners/${params.id}/tag`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayTag: nextTag }) });
      const body = await response.json();
      if (!response.ok) { setTagError(body.code); return; }
      setPartner(current => current ? { ...current, displayTag: nextTag } : current);
    } finally { setTagSaving(false); }
  }

  const tagLabels = lang === "vi"
    ? { title: "Nhãn", placeholder: "VD: Nhà cung cấp thay thế", save: "Lưu" }
    : { title: "태그", placeholder: "예: 대체 구매처", save: "저장" };
  const supplyEmpty = lang === "vi" ? "Chưa có mặt hàng được liên kết." : "아직 연결된 품목이 없습니다.";
  const identityTitle = lang === "vi" ? "Thông tin đối tác" : "거래처 정보";
  const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);

  if (!partner) return <Container noPaddingTop><div className={styles.candidatePage}>{error ? <p className={styles.error} role="alert">{error}</p> : null}</div></Container>;

  return <Container noPaddingTop><div className={styles.candidatePage}>
    <div style={keepingFormCardStyle}>
      <BarSection title={identityTitle} icon="📎" first>
        <div className={styles.candidateIdentity}>
          <div className={styles.candidateIdentityName}>
            <strong>{partner.name}</strong>
            {partner.displayTag ? <span className={styles.tagBadge}>{partner.displayTag}</span> : null}
          </div>
          <span className={`${styles.badge} ${partner.isActive ? styles.activeStatusBadge : styles.inactiveStatusBadge}`}>{partner.isActive ? t.active : t.inactive}</span>
        </div>
        <div className={styles.detailTabs} role="tablist">
          <button type="button" role="tab" aria-selected={detailTab === "items"} className={detailTab === "items" ? styles.detailTabActive : ""} onClick={() => setDetailTab("items")}>{t.itemsTab}</button>
          <button type="button" role="tab" aria-selected={detailTab === "priceChanges"} className={detailTab === "priceChanges" ? styles.detailTabActive : ""} onClick={() => void openPriceChanges()}>{t.priceChangesTab}</button>
        </div>
        {detailTab === "items" ? <div className={styles.candidateItems} role="tabpanel">
          {linkedInventory.length > 0 ? linkedInventory.map(item => {
            const category = lang === "vi" ? item.categoryVi || item.category : item.category || item.categoryVi;
            const name = lang === "vi" ? item.itemNameVi || item.itemName : item.itemName || item.itemNameVi;
            return <div className={`${styles.supplyItem}${item.isActive ? "" : ` ${styles.supplyItemInactive}`}`} key={item.id}>
              <span className={styles.supplyItemCategory}>{category || "-"}</span>
              <span className={styles.supplyItemName}>{name || "-"}</span>
              <span className={styles.supplyItemPrice}>{item.purchasePrice === null ? "-" : `${new Intl.NumberFormat("vi-VN").format(Number(item.purchasePrice))} ₫`}</span>
            </div>;
          }) : <p className={styles.candidateItemsEmpty}>{supplyEmpty}</p>}
        </div> : <div className={styles.priceChanges} role="tabpanel">
          {priceChangesStatus === "loading" ? <p className={styles.candidateItemsEmpty}>{t.priceChangesLoading}</p>
            : priceChangesStatus === "error" ? <p className={styles.error} role="alert">{t.priceChangesLoadFailed}</p>
            : priceChanges.length > 0 ? priceChanges.map(change => {
            const itemName = lang === "vi" ? change.itemNameVi || change.itemName : change.itemName || change.itemNameVi;
            const rising = change.difference > 0;
            return <div className={styles.priceChangeRow} key={change.id}>
              <strong>{itemName || "-"}</strong>
              <span className={styles.priceChangeValues}>{money(change.previousPrice)} → {money(change.newPrice)} ₫</span>
              <span className={rising ? styles.priceRise : styles.priceFall}>{rising ? "▲" : "▼"} {money(Math.abs(change.difference))} ₫{change.percentage === null ? "" : ` · ${change.percentage.toFixed(1)}%`}</span>
              <time dateTime={change.businessDate}>{change.businessDate}</time>
            </div>;
          }) : <p className={styles.candidateItemsEmpty}>{t.noPriceChanges}</p>}
        </div>}
      </BarSection>
      <PartnerForm key={`${partner.id}-${partner.name}-${partner.isActive}`} lang={lang} initial={partner} fundAccounts={fundAccounts} partnerSubtypes={partnerSubtypes} first={false} slim onSubmit={update} />
      <BarSection title={tagLabels.title} icon="🏷️">
        <div style={{ display: "flex", gap: 8 }}>
          <input value={tagInput} maxLength={30} placeholder={tagLabels.placeholder} onChange={event => setTagInput(event.target.value)} style={{ ...keepingInputStyle, flex: 1 }} />
          <button type="button" disabled={tagSaving} onClick={() => void saveTag()} style={{ ...primaryButtonStyle, opacity: tagSaving ? .6 : 1 }}>{tagSaving ? t.saving : tagLabels.save}</button>
        </div>
        {tagError ? <p className={styles.error} role="alert">{tagError}</p> : null}
      </BarSection>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </div></Container>;
}
