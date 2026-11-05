import Link from "next/link";
import { duplicatePartnerMessage, type DuplicatePartner } from "@/lib/partners/duplicate-partner";
import styles from "@/app/(protected)/admin/partners/partners.module.css";

// 409 DUPLICATE_NAME: names the already registered partner and opens it instead of creating one.
export default function DuplicatePartnerNotice({ lang, partner, action }: { lang: "ko" | "vi"; partner: DuplicatePartner | null; action?: React.ReactNode }) {
  return <div className={styles.error} role="alert" data-testid="duplicate-partner-notice">
    <p style={{ margin: 0 }}>{duplicatePartnerMessage(lang, partner)}</p>
    {action ?? (partner ? <Link href={`/admin/partners/${partner.id}`} style={{ display: "inline-block", marginTop: 6, fontWeight: 800, textDecoration: "underline" }}>
      {lang === "vi" ? "Mở đối tác hiện có" : "기존 거래처 열기"}
    </Link> : null)}
  </div>;
}
