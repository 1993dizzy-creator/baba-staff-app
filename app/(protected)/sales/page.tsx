"use client";

import type { CSSProperties } from "react";

export default function SalesPage() {
  return (
    <main style={styles.page}>
      <div style={styles.wrap}>
        <section style={styles.hero}>
          <div>
            <div style={styles.eyebrow}>SALES</div>
            <h1 style={styles.title}>일매출 현황</h1>
            <p style={styles.desc}>
              CUKCUK POS 데이터를 기준으로 오늘 매출, 주문 수, 인기 메뉴를 확인하는 대시보드로
              구성할 예정입니다.
            </p>
          </div>
        </section>

        <section style={styles.grid}>
          <StatCard label="오늘 매출" value="준비 중" />
          <StatCard label="주문 수" value="준비 중" />
          <StatCard label="인기 메뉴" value="준비 중" />
        </section>

        <section style={styles.card}>
          <h2 style={styles.sectionTitle}>매출 대시보드 준비 중</h2>
          <p style={styles.sectionDesc}>
            이 화면은 일반 매출 확인용으로 사용합니다. POS 재고 차감 검수와 매핑 관리는
            관리자 페이지의 POS 관리에서 처리합니다.
          </p>
        </section>
      </div>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f6f5f2",
    padding: "18px 14px 96px",
    color: "#111827",
  },
  wrap: {
    maxWidth: 760,
    margin: "0 auto",
  },
  hero: {
    marginBottom: 14,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: 900,
    color: "#6b7280",
    letterSpacing: 0.6,
  },
  title: {
    margin: "6px 0 8px",
    fontSize: 26,
    fontWeight: 950,
  },
  desc: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.5,
    color: "#6b7280",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 10,
    marginBottom: 12,
  },
  statCard: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 16,
    padding: 14,
    boxShadow: "0 10px 24px rgba(15, 23, 42, 0.05)",
  },
  statLabel: {
    fontSize: 12,
    fontWeight: 800,
    color: "#6b7280",
    marginBottom: 8,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 950,
    color: "#111827",
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 18,
    padding: 16,
    boxShadow: "0 10px 24px rgba(15, 23, 42, 0.05)",
  },
  sectionTitle: {
    margin: "0 0 8px",
    fontSize: 16,
    fontWeight: 950,
  },
  sectionDesc: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.5,
    color: "#6b7280",
    fontWeight: 600,
  },
} satisfies Record<string, CSSProperties>;