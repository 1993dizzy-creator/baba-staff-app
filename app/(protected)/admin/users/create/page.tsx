"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

export default function AdminUserCreatePage() {
  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <Link href="/admin" style={styles.back}>
          ← 관리자 홈
        </Link>

        <div style={styles.eyebrow}>USER ADMIN</div>
        <h1 style={styles.title}>회원 생성</h1>
        <p style={styles.desc}>
          직원 계정 생성, 파트, 직급, 권한, 근무 시작/종료 시간 설정 화면을 이곳에 만들 예정입니다.
        </p>

        <div style={styles.notice}>
          아직 실제 생성 기능은 연결하지 않았습니다. 먼저 관리자 구조 분리만 완료합니다.
        </div>
      </section>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f6f5f2",
    padding: "28px 22px 96px",
    color: "#111827",
  },
  card: {
    maxWidth: 720,
    margin: "0 auto",
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 20,
    padding: 22,
    boxShadow: "0 12px 28px rgba(15, 23, 42, 0.06)",
  },
  back: {
    display: "inline-flex",
    marginBottom: 18,
    color: "#6b7280",
    fontSize: 13,
    fontWeight: 800,
    textDecoration: "none",
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: 900,
    color: "#6b7280",
    letterSpacing: 0.7,
  },
  title: {
    margin: "6px 0 8px",
    fontSize: 28,
    fontWeight: 950,
  },
  desc: {
    margin: "0 0 16px",
    fontSize: 14,
    lineHeight: 1.5,
    color: "#6b7280",
  },
  notice: {
    padding: 14,
    borderRadius: 14,
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    fontSize: 13,
    lineHeight: 1.45,
    color: "#374151",
    fontWeight: 700,
  },
} satisfies Record<string, CSSProperties>;