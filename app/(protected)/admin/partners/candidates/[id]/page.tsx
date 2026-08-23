"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import Container from "@/components/Container";
import CandidatePartnerReviewForm from "@/components/CandidatePartnerReviewForm";
import { BarField, BarSection, BarSegmentedControl, dangerButtonStyle, keepingFormCardStyle, keepingInputStyle, primaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import type { FundAccount, PartnerFormValue } from "@/components/PartnerForm";
import type { InventoryCategoryGroup } from "@/lib/inventory/category-groups";
import { useLanguage } from "@/lib/language-context";
import styles from "../../partners.module.css";

type Alias = { id: number; supplierName: string; status: "pending" | "linked" | "ignored" | "archived"; businessPartnerId: number | null; inventoryCount: number; activeInventoryCount: number; dominantInventoryGroup: InventoryCategoryGroup | null };
type Partner = { id: number; name: string; isActive: boolean };
type InventoryItem = { id: number; supplier: string | null; itemName: string | null; itemNameVi: string | null; part: string | null; category: string | null; categoryVi: string | null; isActive: boolean };
type Action = "create_partner" | "link_existing" | "ignore";

function CandidateIdentity({ alias, inventoryItems, lang, statusLabel }: { alias: Alias; inventoryItems: InventoryItem[]; lang: "ko" | "vi"; statusLabel: string }) {
  return <>
    <div className={styles.candidateIdentity}>
      <div className={styles.candidateIdentityName}>
        {alias.dominantInventoryGroup ? <span className={styles.groupBadge}>{alias.dominantInventoryGroup[lang]}</span> : null}
        <strong>{alias.supplierName}</strong>
      </div>
      <span className={styles.badge}>{statusLabel}</span>
    </div>
    <div className={styles.candidateItems} role="list">
      {inventoryItems.length > 0 ? inventoryItems.map(item => {
        const category = lang === "vi" ? item.categoryVi || item.category : item.category || item.categoryVi;
        const name = lang === "vi" ? item.itemNameVi || item.itemName : item.itemName || item.itemNameVi;
        return <div className={styles.candidateItem} key={item.id} role="listitem"><span className={styles.candidateItemCategory}>{category || "-"}</span><span className={styles.candidateItemName}>{name || "-"}</span></div>;
      }) : <p className={styles.candidateItemsEmpty}>{lang === "vi" ? "Không có mặt hàng liên kết" : "연결된 품목이 없습니다."}</p>}
    </div>
  </>;
}

export default function SupplierCandidatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { lang } = useLanguage();
  const [alias, setAlias] = useState<Alias | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [fundAccounts, setFundAccounts] = useState<FundAccount[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [action, setAction] = useState<Action>("create_partner");
  const [existingPartnerId, setExistingPartnerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/partners/aliases/${id}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code);
    setAlias(body.alias); setPartners(body.partners); setFundAccounts(body.fundAccounts); setInventoryItems(body.inventoryItems ?? []);
  }, [id]);
  useEffect(() => { void load().catch(error => setError(String(error))); }, [load]);

  const labels = lang === "vi" ? {
    pending: "Chờ duyệt", linked: "Đã liên kết", create: "Tạo đối tác mới", existing: "Liên kết đối tác hiện có", ignore: "Không đăng ký",
    choose: "Chọn đối tác", save: "Lưu xử lý", reopen: "Đưa về chờ duyệt", review: "Xét duyệt đăng ký", info: "Thông tin đăng ký", reviewAgain: "Xét duyệt lại",
    remove: "Xóa", removeSection: "Dọn dẹp", removeConfirm: "Bạn có muốn xóa đối tác chờ duyệt không còn mặt hàng liên kết này không?",
    removeInUse: "Không thể xóa vì vẫn còn mặt hàng liên kết.", archived: "Đã xóa",
  } : {
    pending: "등록 대기", linked: "연결 완료", create: "새 정규 거래처로 등록", existing: "기존 정규 거래처에 연결", ignore: "등록하지 않음",
    choose: "거래처 선택", save: "처리 저장", reopen: "등록 대기로 되돌리기", review: "등록 검토", info: "등록 정보", reviewAgain: "다시 검토",
    remove: "삭제", removeSection: "정리", removeConfirm: "연결된 품목이 없는 등록대기 거래처를 삭제하시겠습니까?",
    removeInUse: "연결된 품목이 남아 있어 삭제할 수 없습니다.", archived: "삭제됨",
  };

  async function review(payload: Record<string, unknown>) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/partners/aliases/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) { setError(body.code); return false; }
      router.push(body.result?.partnerId ? `/admin/partners/${body.result.partnerId}` : "/admin/partners");
      return true;
    } finally { setBusy(false); }
  }
  async function createPartner(partner: PartnerFormValue) { return review({ action: "create_partner", partner }); }
  async function removeCandidate() {
    if (!window.confirm(labels.removeConfirm)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/partners/aliases/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive" }) });
      const body = await response.json();
      if (!response.ok) { setError(body.code === "CANDIDATE_IN_USE" ? labels.removeInUse : body.code); return; }
      router.push("/admin/partners");
    } finally { setBusy(false); }
  }
  if (!alias) return <Container>{error ? <p className={styles.error}>{error}</p> : null}</Container>;

  const page = (content: ReactNode) => <Container noPaddingTop><div className={styles.candidatePage}>{content}</div></Container>;
  const identity = (statusLabel: string) => <CandidateIdentity alias={alias} inventoryItems={inventoryItems} lang={lang} statusLabel={statusLabel} />;
  if (alias.status === "archived") return page(<div style={keepingFormCardStyle}><BarSection title={labels.info} icon="📎" first>{identity(labels.archived)}</BarSection></div>);
  if (alias.status === "linked" && alias.businessPartnerId) return page(<div style={keepingFormCardStyle}><BarSection title={labels.info} icon="📎" first>{identity(labels.linked)}</BarSection></div>);
  if (alias.status === "ignored") return page(<div style={keepingFormCardStyle}><BarSection title={labels.info} icon="📎" first>{identity(labels.ignore)}</BarSection><BarSection title={labels.reviewAgain}><button disabled={busy} onClick={() => void review({ action: "reopen" })} style={{ ...primaryButtonStyle, width: "100%", opacity: busy ? .6 : 1 }}>{labels.reopen}</button></BarSection></div>);

  const initial: PartnerFormValue = { name: alias.supplierName, partnerType: "other", paymentMode: "immediate", settlementMode: null, settlementRule: null, defaultPaymentTermDays: null, defaultFundAccountId: null, contactName: null, phone: null, memo: null, isActive: true, ledgerPartyId: null };
  return page(<div style={keepingFormCardStyle}>
    <BarSection title={labels.review} icon="📋" first>
      {identity(labels.pending)}
      <BarSegmentedControl<Action> label={lang === "vi" ? "Cách xét duyệt" : "검토 방식"} value={action} disabled={busy} onChange={setAction} options={lang === "vi" ? [{ value: "create_partner", label: "Tạo mới" }, { value: "link_existing", label: "Liên kết" }, { value: "ignore", label: "Bỏ qua" }] : [{ value: "create_partner", label: "새 거래처" }, { value: "link_existing", label: "기존 거래처" }, { value: "ignore", label: "등록 안 함" }]} />
    </BarSection>
    {action === "create_partner" ? <CandidatePartnerReviewForm lang={lang} initial={initial} fundAccounts={fundAccounts} submitLabel={labels.save} onSubmit={createPartner} /> : null}
    {action === "link_existing" ? <BarSection title={labels.existing} icon="🔗"><BarField label={labels.choose}>{({ id }) => <select id={id} value={existingPartnerId} onChange={event => setExistingPartnerId(event.target.value)} style={keepingInputStyle}><option value="">{labels.choose}</option>{partners.filter(row => row.isActive).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>}</BarField><button disabled={busy || !existingPartnerId} onClick={() => void review({ action: "link_existing", existingPartnerId: Number(existingPartnerId) })} style={{ ...primaryButtonStyle, width: "100%", opacity: busy || !existingPartnerId ? .6 : 1 }}>{labels.save}</button></BarSection> : null}
    {action === "ignore" ? <BarSection title={labels.ignore} icon="🚫"><button disabled={busy} onClick={() => void review({ action: "ignore" })} style={{ ...primaryButtonStyle, width: "100%", opacity: busy ? .6 : 1 }}>{labels.ignore}</button></BarSection> : null}
    {alias.inventoryCount === 0 ? <BarSection title={labels.removeSection} icon="🗑️"><button disabled={busy} onClick={() => void removeCandidate()} style={{ ...dangerButtonStyle, width: "100%", opacity: busy ? .6 : 1 }}>{labels.remove}</button></BarSection> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
  </div>);
}
