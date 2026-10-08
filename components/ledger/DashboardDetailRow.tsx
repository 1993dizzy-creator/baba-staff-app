import styles from "@/app/(protected)/admin/ledger/ledger-dashboard.module.css";

export default function DashboardDetailRow({ emoji, name, amount }: { emoji: string; name: string; amount: string }) {
  return <div className={styles.detailRow}>
    <span className={styles.detailEmoji} aria-hidden="true">{emoji}</span>
    <span className={styles.detailName}>{name}</span>
    <strong className={styles.detailAmount}>{amount}</strong>
  </div>;
}
