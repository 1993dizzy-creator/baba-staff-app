"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isLoggedIn, getUser } from "@/lib/supabase/auth";
import Link from "next/link";
import { LanguageProvider, useLanguage } from "@/lib/language-context";
import { layoutText } from "@/lib/text/layout";

function ProtectedLayoutContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);
  const [currentUserName, setCurrentUserName] = useState("");
  const { lang, toggleLang } = useLanguage();

  const t = layoutText[lang];

  useEffect(() => {
    if (!isLoggedIn()) {
      alert(lang === "vi" ? "Vui lòng đăng nhập trước" : "로그인 후 접근 가능");
      router.replace("/login");
      return;
    }

    const user = getUser();
    setCurrentUserName(user?.name || "");
    setChecked(true);
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem("baba_user");
    alert(t.logoutDone);
    router.push("/login");
  };



  if (!checked) {
    return <main style={{ padding: 40 }}>{t.checking}</main>;
  }

  const handleToggleLanguage = () => {
    toggleLang();
  };

  const isSalesPage = pathname.startsWith("/sales");
  const isInventoryPage = pathname.startsWith("/inventory");
  const isMyPage = pathname.startsWith("/mypage");

  return (

    <div style={{ minHeight: "100vh", paddingBottom: 90 }}>
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: "12px 20px 0",
          minHeight: 56,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <p
          style={{
            margin: 0,
            color: "#666",
            fontSize: 14,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
          }}
        >
          {currentUserName
            ? `${currentUserName} ${t.loggedInSuffix}`
            : ""}
        </p>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button
            onClick={handleToggleLanguage}
            style={{
              padding: "8px 10px",
              minWidth: 44,
              height: 40,
              borderRadius: 10,
              border: "1px solid #ddd",
              background: "white",
              cursor: "pointer",
              fontSize: 16,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {lang === "ko" ? "🇰🇷" : "🇻🇳"}
          </button>

          <button
            onClick={handleLogout}
            style={{
              padding: "0 12px",
              height: 40,
              border: "1px solid #ddd",
              borderRadius: 10,
              background: "white",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            {t.logout}
          </button>
        </div>
      </div>

      {children}

      <nav
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: "white",
          borderTop: "1px solid #e5e5e5",
          boxShadow: "0 -4px 12px rgba(0,0,0,0.04)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          padding: "6px 6px max(6px, env(safe-area-inset-bottom))",
          gap: 6,
          zIndex: 100,
          height: 64,
        }}
      >
        {/* <Link
          href="/sales"
          style={{
            textAlign: "center",
            textDecoration: "none",
            color: isSalesPage ? "black" : "#999",
            fontWeight: isSalesPage ? 700 : 500,
            padding: "10px 0",
            borderRadius: 10,
            background: isSalesPage ? "#f1f1f1" : "transparent",
            boxShadow: isSalesPage ? "inset 0 0 0 1px #e5e5e5" : "none",
            fontSize: 13,
          }}
        >
          {t.sales}
        </Link> */}

        <div
          style={{
            textAlign: "center",
            color: "#bbb",
            fontWeight: 500,
            padding: "10px 0",
            borderRadius: 10,
            fontSize: 13,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            lineHeight: 1.2,
          }}
        >
          <span>{t.sales}</span>
          <span style={{ fontSize: 11, marginTop: 2 }}>{t.preparing}</span>
        </div>

        <Link
          href="/inventory"
          style={{
            textAlign: "center",
            textDecoration: "none",
            color: isInventoryPage ? "black" : "#999",
            fontWeight: isInventoryPage ? 700 : 500,
            padding: "10px 0",
            borderRadius: 10,
            background: isInventoryPage ? "#f5f5f5" : "transparent",
            fontSize: 13,
          }}
        >
          {t.inventory}
        </Link>

        <Link
          href="/mypage"
          style={{
            textAlign: "center",
            textDecoration: "none",
            color: isMyPage ? "black" : "#999",
            fontWeight: isMyPage ? 700 : 500,
            padding: "10px 0",
            borderRadius: 10,
            background: isMyPage ? "#f5f5f5" : "transparent",
            fontSize: 13,
          }}
        >
          {t.mypage}
        </Link>

        <div
          style={{
            textAlign: "center",
            color: "#bbb",
            fontWeight: 500,
            padding: "10px 0",
            borderRadius: 10,
            fontSize: 13,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            lineHeight: 1.2,
          }}
        >
          <span>{t.attendance}</span>
          <span style={{ fontSize: 11, marginTop: 2 }}>{t.preparing}</span>
        </div>

      </nav >
    </div >
  );
}

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LanguageProvider>
      <ProtectedLayoutContent>{children}</ProtectedLayoutContent>
    </LanguageProvider>
  );
}