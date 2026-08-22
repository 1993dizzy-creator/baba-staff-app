"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Container from "@/components/Container";
import PartnerForm, { type PartnerFormValue } from "@/components/PartnerForm";
import { useLanguage } from "@/lib/language-context";
import styles from "../../partners.module.css";

type Alias = { id: number; supplierName: string; status: "pending" | "linked" | "ignored"; businessPartnerId: number | null; inventoryCount: number; activeInventoryCount: number };
type Partner = { id: number; name: string; isActive: boolean };
type Action = "create_partner" | "link_existing" | "ignore";

export default function SupplierCandidatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { lang } = useLanguage();
  const [alias, setAlias] = useState<Alias | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [action, setAction] = useState<Action>("create_partner");
  const [existingPartnerId, setExistingPartnerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/partners/aliases/${id}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code);
    setAlias(body.alias); setPartners(body.partners);
  }, [id]);
  useEffect(() => { void load().catch(error => setError(String(error))); }, [load]);

  const labels = lang === "vi" ? {
    back: "Đăng ký", pending: "Chờ duyệt", raw: "Tên đang dùng", linked: "Hàng tồn kho liên kết",
    create: "Đăng ký đối tác mới", existing: "Liên kết đối tác hiện có", ignore: "Không đăng ký",
    choose: "Chọn đối tác", save: "Lưu xử lý", reopen: "Đưa về chờ duyệt",
  } : {
    back: "등록", pending: "등록 대기", raw: "현재 사용 이름", linked: "연결 재고",
    create: "새 정규 거래처로 등록", existing: "기존 정규 거래처에 연결", ignore: "등록하지 않음",
    choose: "거래처 선택", save: "처리 저장", reopen: "등록 대기로 되돌리기",
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

  if (!alias) return <Container><main className={styles.page}>{error ? <p className={styles.error}>{error}</p> : null}</main></Container>;
  if (alias.status === "linked" && alias.businessPartnerId) return <Container><main className={styles.page}><Link className={styles.backLink} href="/admin/partners">← {labels.back}</Link><header className={styles.detailTop}><h1>{alias.supplierName}</h1><span className={styles.badge}>{lang === "vi" ? "Đã liên kết" : "연결 완료"}</span></header></main></Container>;
  if (alias.status === "ignored") return <Container><main className={styles.page}><Link className={styles.backLink} href="/admin/partners">← {labels.back}</Link><header className={styles.detailTop}><h1>{alias.supplierName}</h1><span className={styles.badge}>{labels.ignore}</span></header><button className={styles.primary} disabled={busy} onClick={() => void review({ action: "reopen" })}>{labels.reopen}</button></main></Container>;

  const initial: PartnerFormValue = { name: alias.supplierName, partnerType: "other", paymentMode: "immediate", defaultPaymentTermDays: null, contactName: null, phone: null, memo: null, isActive: true, ledgerPartyId: null };
  return <Container><main className={`${styles.page} ${styles.candidatePage}`}>
    <Link className={styles.backLink} href="/admin/partners">← {labels.back}</Link>
    <header className={styles.detailTop}><h1>{alias.supplierName}</h1><span className={styles.badge}>{labels.pending}</span></header>
    <p className={styles.candidateSummary}>{lang === "vi" ? `Kho ${alias.inventoryCount} · đang dùng ${alias.activeInventoryCount}` : `재고 ${alias.inventoryCount} · 사용 ${alias.activeInventoryCount}`}</p>
    <section className={styles.candidateReviewCard}><section className={styles.reviewSection}><h2>{lang === "vi" ? "Cách xét duyệt" : "검토 방식"}</h2><div className={styles.reviewChoices}>{(["create_partner", "link_existing", "ignore"] as Action[]).map(value => <label key={value}><input type="radio" name="reviewAction" checked={action === value} onChange={() => setAction(value)} />{value === "create_partner" ? labels.create : value === "link_existing" ? labels.existing : labels.ignore}</label>)}</div></section>
      {action === "create_partner" ? <PartnerForm lang={lang} initial={initial} ledgerParties={[]} submitLabel={labels.save} showLedgerParty={false} showActive={false} layout="page" onSubmit={createPartner} /> : null}
      {action === "link_existing" ? <div className={styles.inlineAction}><select value={existingPartnerId} onChange={event => setExistingPartnerId(event.target.value)}><option value="">{labels.choose}</option>{partners.filter(row => row.isActive).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><button className={styles.primary} disabled={busy || !existingPartnerId} onClick={() => void review({ action: "link_existing", existingPartnerId: Number(existingPartnerId) })}>{labels.save}</button></div> : null}
      {action === "ignore" ? <button className={styles.primary} disabled={busy} onClick={() => void review({ action: "ignore" })}>{labels.ignore}</button> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </section>
  </main></Container>;
}
