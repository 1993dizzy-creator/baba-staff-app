import { formatPartnerSettlementTerm } from "@/lib/partners/text";
import type { SettlementPolicyValue } from "@/lib/ledger/settlement-periods";
import styles from "./SettlementPeriodSummary.module.css";

// Read-only, compact: the top of the payable sheets shows the settlement term only
// (e.g. "📅 매월 15일·말일 정산"). 거래기간·예상 기준일·건수·금액 live in the 정산그룹
// headers of the date list below, so they are not repeated here.
export default function SettlementPeriodSummary({ lang, policy }: { lang: "ko" | "vi"; policy: SettlementPolicyValue | null | undefined }) {
  const term = policy ? formatPartnerSettlementTerm(policy, lang) : null;
  if (!term) return null;
  return <section className={styles.block} data-testid="settlement-period-summary">
    <div className={styles.line}>
      <span className={styles.summary}><span aria-hidden="true">📅 </span>{term}</span>
    </div>
  </section>;
}
