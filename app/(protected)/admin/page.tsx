"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

const adminMenus = [
  {
    title: "POS 관리",
    description: "CUKCUK POS 연동, dry-run, 재고 차감 검수 상태를 확인합니다.",
    href: "/admin/pos",
    badge: "POS",
    status: "연동 관리",
  },
  {
    title: "회원 생성",
    description: "직원 계정, 권한, 파트, 직급, 근무 시간을 설정합니다.",
    href: "/admin/users/create",
    badge: "USER",
    status: "준비 중",
  },
  {
    title: "급여 관리",
    description: "근태 기록을 기준으로 급여 정산 화면을 준비합니다.",
    href: "/admin/payroll",
    badge: "PAY",
    status: "준비 중",
  },
];

export default function AdminPage() {
  return (
    <main style={styles.page}>
      <div style={styles.wrap}>
        <section style={styles.hero}>
          <div>
            <div style={styles.eyebrow}>BABA ADMIN</div>
            <h1 style={styles.title}>관리자 허브</h1>
            <p style={styles.desc}>
              owner/master 전용 운영 관리 영역입니다. 직원용 모바일 화면과 분리해
              POS, 회원, 급여 같은 관리자 기능을 이곳에서 관리합니다.
            </p>
          </div>

          <div style={styles.heroBadge}>
            <span style={styles.badgeDot} />
            관리자 전용
          </div>
        </section>

        <section style={styles.summaryBar}>
          <div style={styles.summaryItem}>
            <span style={styles.summaryLabel}>권한</span>
            <strong style={styles.summaryValue}>Owner / Master</strong>
          </div>
          <div style={styles.summaryDivider} />
          <div style={styles.summaryItem}>
            <span style={styles.summaryLabel}>화면 성격</span>
            <strong style={styles.summaryValue}>PC 중심 관리</strong>
          </div>
          <div style={styles.summaryDivider} />
          <div style={styles.summaryItem}>
            <span style={styles.summaryLabel}>현재 단계</span>
            <strong style={styles.summaryValue}>구조 분리</strong>
          </div>
        </section>

        <section style={styles.sectionHeader}>
          <div>
            <h2 style={styles.sectionTitle}>관리 메뉴</h2>
            <p style={styles.sectionDesc}>
              순수 관리자 기능부터 이 영역으로 분리합니다.
            </p>
          </div>
        </section>

        <section style={styles.grid}>
          {adminMenus.map((menu) => (
            <Link key={menu.href} href={menu.href} style={styles.card}>
              <div style={styles.cardTop}>
                <span style={styles.cardBadge}>{menu.badge}</span>
                <span style={styles.cardStatus}>{menu.status}</span>
              </div>

              <div style={styles.cardBody}>
                <h3 style={styles.cardTitle}>{menu.title}</h3>
                <p style={styles.cardDesc}>{menu.description}</p>
              </div>

              <div style={styles.cardFooter}>
                <span style={styles.openText}>열기</span>
                <span style={styles.arrow}>→</span>
              </div>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f4f1ea",
    padding: "28px 22px 96px",
    color: "#111827",
  },
  wrap: {
    width: "100%",
    maxWidth: 1080,
    margin: "0 auto",
  },

  hero: {
    display: "flex",
    justifyContent: "space-between",
    gap: 20,
    alignItems: "flex-start",
    padding: 24,
    borderRadius: 24,
    background:
      "linear-gradient(135deg, #111827 0%, #1f2937 54%, #374151 100%)",
    color: "#ffffff",
    boxShadow: "0 18px 38px rgba(15, 23, 42, 0.18)",
    marginBottom: 14,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: 900,
    color: "#d1d5db",
    letterSpacing: 0.8,
  },
  title: {
    margin: "8px 0 10px",
    fontSize: 32,
    lineHeight: 1.15,
    fontWeight: 950,
    letterSpacing: "-0.8px",
  },
  desc: {
    maxWidth: 640,
    margin: 0,
    fontSize: 14,
    lineHeight: 1.55,
    color: "#d1d5db",
    fontWeight: 600,
  },
  heroBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
    height: 34,
    padding: "0 12px",
    borderRadius: 999,
    background: "rgba(255,255,255,0.1)",
    border: "1px solid rgba(255,255,255,0.16)",
    color: "#ffffff",
    fontSize: 12,
    fontWeight: 900,
  },
  badgeDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    background: "#22c55e",
  },

  summaryBar: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    padding: "14px 18px",
    borderRadius: 18,
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    boxShadow: "0 10px 24px rgba(15, 23, 42, 0.05)",
    marginBottom: 22,
  },
  summaryItem: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  summaryLabel: {
    fontSize: 11,
    color: "#6b7280",
    fontWeight: 900,
  },
  summaryValue: {
    fontSize: 14,
    color: "#111827",
    fontWeight: 950,
  },
  summaryDivider: {
    width: 1,
    height: 30,
    background: "#e5e7eb",
  },

  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    margin: 0,
    fontSize: 18,
    fontWeight: 950,
    letterSpacing: "-0.3px",
  },
  sectionDesc: {
    margin: "5px 0 0",
    fontSize: 13,
    lineHeight: 1.45,
    color: "#6b7280",
    fontWeight: 600,
  },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
    gap: 14,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    minHeight: 188,
    padding: 18,
    borderRadius: 22,
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    boxShadow: "0 12px 28px rgba(15, 23, 42, 0.06)",
    color: "inherit",
    textDecoration: "none",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
  },
  cardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    marginBottom: 18,
  },
  cardBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 28,
    padding: "0 10px",
    borderRadius: 999,
    background: "#111827",
    color: "#ffffff",
    fontSize: 11,
    fontWeight: 950,
    letterSpacing: 0.3,
  },
  cardStatus: {
    display: "inline-flex",
    alignItems: "center",
    height: 26,
    padding: "0 9px",
    borderRadius: 999,
    background: "#f3f4f6",
    color: "#6b7280",
    fontSize: 11,
    fontWeight: 900,
    whiteSpace: "nowrap",
  },
  cardBody: {
    flex: 1,
  },
  cardTitle: {
    margin: "0 0 8px",
    fontSize: 18,
    lineHeight: 1.3,
    fontWeight: 950,
    letterSpacing: "-0.3px",
  },
  cardDesc: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.5,
    color: "#6b7280",
    fontWeight: 600,
  },
  cardFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 18,
    paddingTop: 14,
    borderTop: "1px solid #f3f4f6",
  },
  openText: {
    fontSize: 12,
    fontWeight: 900,
    color: "#374151",
  },
  arrow: {
    width: 28,
    height: 28,
    borderRadius: 999,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#f9fafb",
    color: "#111827",
    fontSize: 16,
    fontWeight: 950,
  },
} satisfies Record<string, CSSProperties>;