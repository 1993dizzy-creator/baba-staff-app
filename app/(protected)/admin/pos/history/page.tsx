export default function AdminPosHistoryPage() {
  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <div style={styles.eyebrow}>CUKCUK POS</div>
        <h1 style={styles.title}>처리 내역</h1>
        <p style={styles.description}>
          dry-run, pending, applied, skipped, failed 처리 내역을 확인하는 화면입니다.
        </p>
        <div style={styles.notice}>현재는 placeholder입니다. 이후 processed line 로그와 연결합니다.</div>
      </section>
    </main>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#f6f5f2", padding: "14px 12px 96px" },
  card: {
    maxWidth: 760,
    margin: "0 auto",
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 16,
    boxShadow: "0 8px 22px rgba(15, 23, 42, 0.05)",
  },
  eyebrow: { fontSize: 11, fontWeight: 900, color: "#6b7280", letterSpacing: 0.4 },
  title: { margin: "5px 0 7px", fontSize: 24, fontWeight: 950, color: "#111827" },
  description: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "#6b7280", fontWeight: 650 },
  notice: {
    marginTop: 14,
    padding: 12,
    borderRadius: 15,
    background: "#fffbeb",
    border: "1px solid #fde68a",
    color: "#92400e",
    fontSize: 13,
    lineHeight: 1.45,
    fontWeight: 750,
  },
};