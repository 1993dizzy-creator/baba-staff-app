"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { getUser, isManage } from "@/lib/supabase/auth";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled) return;

      const user = getUser();

      if (!user || !isManage(user)) {
        setAllowed(false);
        setChecked(true);
        router.replace("/");
        return;
      }

      setAllowed(true);
      setChecked(true);
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!checked) {
    return (
      <main style={styles.centerPage}>
        <div style={styles.loadingCard}>관리자 권한 확인 중...</div>
      </main>
    );
  }

  if (!allowed) {
    return (
      <main style={styles.centerPage}>
        <div style={styles.loadingCard}>관리자 권한이 없습니다.</div>
      </main>
    );
  }

  return <>{children}</>;
}

const styles = {
  centerPage: {
    minHeight: "100vh",
    background: "#f6f5f2",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  loadingCard: {
    background: "#ffffff",
    border: "1px solid #e5e7eb",
    borderRadius: 18,
    padding: "18px 20px",
    fontSize: 14,
    fontWeight: 800,
    color: "#111827",
    boxShadow: "0 12px 28px rgba(15, 23, 42, 0.06)",
  },
} satisfies Record<string, CSSProperties>;
