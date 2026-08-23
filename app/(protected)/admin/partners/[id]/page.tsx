"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Container from "@/components/Container";
import { BarSection, keepingFormCardStyle, keepingInputStyle, primaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import PartnerForm, { type FundAccount, type PartnerFormValue } from "@/components/PartnerForm";
import { useLanguage } from "@/lib/language-context";
import { partnerText, partnerTypeLabels } from "@/lib/partners/text";
import styles from "../partners.module.css";

type Partner = PartnerFormValue & { id: number; displayTag: string | null };
type LinkedInventory = { id: number; itemName: string | null; itemNameVi: string | null; part: string | null; category: string | null; categoryVi: string | null; purchasePrice: number | string | null; isActive: boolean; rawSupplier: string | null };

export default function PartnerDetailPage() {
  const params = useParams<{ id: string }>(); const { lang } = useLanguage(); const t = partnerText[lang];
  const [partner, setPartner] = useState<Partner | null>(null); const [fundAccounts, setFundAccounts] = useState<FundAccount[]>([]); const [linkedInventory, setLinkedInventory] = useState<LinkedInventory[]>([]); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [tagInput, setTagInput] = useState(""); const [tagSaving, setTagSaving] = useState(false); const [tagError, setTagError] = useState("");
  // ledgerPartyId is preserved from the API response (backend bridge field) even though
  // the form no longer renders a control for it, so an existing link is never dropped on save.
  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/partners/${params.id}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code);
    setPartner({ ...body.partner, ledgerPartyId: body.partner.ledgerParty?.id ?? null });
    setFundAccounts(body.fundAccounts);
    setLinkedInventory(body.linkedInventory);
    setTagInput(body.partner.displayTag ?? "");
  }, [params.id]);
  useEffect(() => { void load().catch(() => setError(t.loadFailed)); }, [load, t.loadFailed]);
  async function update(value: PartnerFormValue) { setError(""); setMessage(""); const response = await fetch(`/api/admin/partners/${params.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }); const body = await response.json(); if (!response.ok) { setError(body.code === "DUPLICATE_NAME" ? t.duplicate : body.code); return false; } setMessage(t.saved); await load(); return true; }

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

  if (!partner) return <Container noPaddingTop><div className={styles.candidatePage}>{error ? <p className={styles.error} role="alert">{error}</p> : null}</div></Container>;

  return <Container noPaddingTop><div className={styles.candidatePage}>
    <div style={keepingFormCardStyle}>
      <BarSection title={identityTitle} icon="📎" first>
        <div className={styles.candidateIdentity}>
          <div className={styles.candidateIdentityName}>
            <span className={styles.groupBadge}>{partnerTypeLabels[partner.partnerType][lang]}</span>
            <strong>{partner.name}</strong>
            {partner.displayTag ? <span className={styles.tagBadge}>{partner.displayTag}</span> : null}
          </div>
          <span className={styles.badge}>{partner.isActive ? t.active : t.inactive}</span>
        </div>
        <div className={styles.candidateItems}>
          {linkedInventory.length > 0 ? linkedInventory.map(item => {
            const category = lang === "vi" ? item.categoryVi || item.category : item.category || item.categoryVi;
            const name = lang === "vi" ? item.itemNameVi || item.itemName : item.itemName || item.itemNameVi;
            return <div className={`${styles.supplyItem}${item.isActive ? "" : ` ${styles.supplyItemInactive}`}`} key={item.id}>
              <span className={styles.supplyItemCategory}>{category || "-"}</span>
              <span className={styles.supplyItemName}>{name || "-"}</span>
              <span className={styles.supplyItemPrice}>{item.purchasePrice === null ? "-" : `${new Intl.NumberFormat("vi-VN").format(Number(item.purchasePrice))} ₫`}</span>
            </div>;
          }) : <p className={styles.candidateItemsEmpty}>{supplyEmpty}</p>}
        </div>
      </BarSection>
      <PartnerForm key={`${partner.id}-${partner.name}-${partner.isActive}`} lang={lang} initial={partner} fundAccounts={fundAccounts} first={false} onSubmit={update} />
      <BarSection title={tagLabels.title} icon="🏷️">
        <div style={{ display: "flex", gap: 8 }}>
          <input value={tagInput} maxLength={30} placeholder={tagLabels.placeholder} onChange={event => setTagInput(event.target.value)} style={{ ...keepingInputStyle, flex: 1 }} />
          <button type="button" disabled={tagSaving} onClick={() => void saveTag()} style={{ ...primaryButtonStyle, opacity: tagSaving ? .6 : 1 }}>{tagSaving ? t.saving : tagLabels.save}</button>
        </div>
        {tagError ? <p className={styles.error} role="alert">{tagError}</p> : null}
      </BarSection>
    </div>
    {message ? <p className={styles.notice} role="status">{message}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </div></Container>;
}
