"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isLoggedIn, getUser, isAdmin } from "@/lib/supabase/auth";
import Link from "next/link";
import { useLanguage } from "@/lib/language-context";
import { layoutText } from "@/lib/text/layout";
import BottomNav from "@/components/BottomNav";
import { supabase } from "@/lib/supabase/client";

function ProtectedLayoutContent({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);
  const [currentUserName, setCurrentUserName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const leaveAlertShownRef = useRef(false);

  const { lang, toggleLang } = useLanguage();
  const t = layoutText[lang];

  useEffect(() => {
    const loggedIn = isLoggedIn();

    if (!loggedIn) {
      setIsReady(true);
      alert(t.loginRequired);
      router.replace("/login");
      return;
    }

    const user = getUser();
    setCurrentUserName(user?.name || "");
    setChecked(true);
    setIsReady(true);
  }, [router, t.loginRequired]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const checkLeaveAlert = async () => {
      if (!checked || !isReady) return;
      if (leaveAlertShownRef.current) return;
      if (pathname === "/attendance/leave") return;

      const user = getUser();
      if (!isAdmin(user)) return;

const { count, error } = await supabase
  .from("attendance_records")
  .select("id", { count: "exact", head: true })
  .eq("status", "leave")
  .eq("approval_status", "pending");

      if (error) return;
      if (!count || count <= 0) return;

      leaveAlertShownRef.current = true;

      const confirmed = window.confirm(
        lang === "vi"
          ? `Có ${count} đơn nghỉ đang chờ duyệt. Bạn có muốn xem không?`
          : `${count}건의 휴무 신청이 대기중입니다. 확인하시겠습니까?`
      );

      if (confirmed) {
        router.push("/attendance/leave");
      }
    };

    checkLeaveAlert();
  }, [checked, isReady, pathname, router, lang]);

  const handleLogout = () => {
    localStorage.removeItem("baba_user");
    alert(t.logoutDone);
    router.push("/login");
  };

  const handleToggleLanguage = () => {
    toggleLang();
  };



  if (!isReady || !checked) {
    return <main style={{ padding: 40 }}>{t.checking}</main>;
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        paddingTop: "calc(54px + env(safe-area-inset-top))",
        paddingBottom: 56,
        background: "#ffffff",
      }}
    >
      <header
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: "calc(54px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          background: "#111827",
          borderBottom: "1px solid #1f2937",
          zIndex: 1100,
          boxShadow: "0 2px 10px rgba(0,0,0,0.10)",
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            height: 54,
            margin: "0 auto",
            padding: "0 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <img
              src="/img/logo-w.png"
              alt="BABA"
              style={{
                height: 38,
                width: "auto",
                objectFit: "contain",
              }}
            />
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              color: "#ffffff",
              fontSize: 14,
              fontWeight: 700,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              letterSpacing: "-0.2px",
            }}
          >
            {currentUserName || "BABA"}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexShrink: 0,
              color: "#ffffff",
              lineHeight: 1,
            }}
          >
            <span
              onClick={handleToggleLanguage}
              style={{
                cursor: "pointer",
                fontSize: 20,
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                userSelect: "none",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {lang === "ko" ? "🇰🇷" : "🇻🇳"}
            </span>

            <div ref={menuRef} style={{ position: "relative" }}>
              <div
                onClick={() => setMenuOpen((prev) => !prev)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  userSelect: "none",
                  WebkitTapHighlightColor: "transparent",
                  padding: 6,
                }}
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <path
                    d="M20 21C20 17.6863 16.4183 15 12 15C7.58172 15 4 17.6863 4 21"
                    stroke="#ffffff"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <circle
                    cx="12"
                    cy="8"
                    r="4"
                    stroke="#ffffff"
                    strokeWidth="2"
                  />
                </svg>
              </div>
              {menuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: 36,
                    right: 0,
                    width: 154,
                    borderRadius: 14,
                    boxShadow: "0 16px 32px rgba(0,0,0,0.16)",
                    background: "#ffffff",
                    border: "1px solid #e5e7eb",
                    overflow: "hidden",
                    zIndex: 1200,
                  }}
                >
                  <Link
                    href="/mypage"
                    style={{
                      display: "block",
                      padding: "12px 14px",
                      textDecoration: "none",
                      color: "#111827",
                      fontSize: 14,
                      fontWeight: 600,
                      borderBottom: "1px solid #f3f4f6",
                      background: pathname.startsWith("/mypage")
                        ? "#f9fafb"
                        : "#ffffff",
                    }}
                  >
                    {t.mypage}
                  </Link>

                  <button
                    onClick={handleLogout}
                    style={{
                      width: "100%",
                      padding: "12px 14px",
                      border: "none",
                      background: "#ffffff",
                      color: "#111827",
                      fontSize: 14,
                      fontWeight: 600,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    {t.logout}
                  </button>
                </div>
              )}
            </div>

          </div>
        </div>
      </header>

      {children}

      <BottomNav />
    </div>
  );
}

export default function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ProtectedLayoutContent>
      {children}
    </ProtectedLayoutContent>
  );
}