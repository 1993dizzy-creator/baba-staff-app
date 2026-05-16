"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useLanguage } from "@/lib/language-context";
import { layoutText } from "@/lib/text/layout";
import { getUser, isManage } from "@/lib/supabase/auth";

const navWrapStyle: CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  height: 60,
  background: "#111827",
  borderTop: "1px solid #1f2937",
  display: "flex",
  justifyContent: "space-around",
  alignItems: "stretch",
  zIndex: 1000,
  boxShadow: "0 -6px 18px rgba(0,0,0,0.16)",
};

const baseItem: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 3,
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1.1,
  textAlign: "center",
  textDecoration: "none",
  userSelect: "none",
  WebkitTapHighlightColor: "transparent",
  letterSpacing: "-0.2px",
};

const iconStyle: CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
};

const adminItemBase: CSSProperties = {
  ...baseItem,
  position: "relative",
  justifyContent: "flex-start",
  paddingTop: 5,
};

const adminCircleBase: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 999,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  marginTop: -22,
  marginBottom: 1,
  border: "3px solid #111827",
  boxShadow: "0 8px 20px rgba(0,0,0,0.32)",
};

function activeItemStyle(): CSSProperties {
  return {
    ...baseItem,
    color: "#ffffff",
    background: "#1f2937",
  };
}

function inactiveItemStyle(): CSSProperties {
  return {
    ...baseItem,
    color: "#9ca3af",
    background: "transparent",
  };
}

function disabledItemStyle(): CSSProperties {
  return {
    ...inactiveItemStyle(),
    border: 0,
    padding: 0,
    fontFamily: "inherit",
    cursor: "not-allowed",
    opacity: 0.72,
  };
}

function adminItemStyle(isActive: boolean): CSSProperties {
  return {
    ...adminItemBase,
    color: isActive ? "#ffffff" : "#e5e7eb",
    background: isActive ? "#1f2937" : "transparent",
  };
}

function adminCircleStyle(isActive: boolean): CSSProperties {
  return {
    ...adminCircleBase,
    background: isActive ? "#ffffff" : "#f9fafb",
    color: "#111827",
  };
}

function AdminIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="4"
        y="4"
        width="6"
        height="6"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="14"
        y="4"
        width="6"
        height="6"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="4"
        y="14"
        width="6"
        height="6"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="14"
        y="14"
        width="6"
        height="6"
        rx="2"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}

export default function BottomNav() {
  const pathname = usePathname();
  const { lang } = useLanguage();
  const t = layoutText[lang];

  const [canUseAdmin, setCanUseAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;

    function refreshUserPermission() {
      if (cancelled) return;
      const user = getUser();
      setCanUseAdmin(isManage(user));
    }

    queueMicrotask(refreshUserPermission);
    window.addEventListener("baba_user_updated", refreshUserPermission);

    return () => {
      cancelled = true;
      window.removeEventListener("baba_user_updated", refreshUserPermission);
    };
  }, []);

  const isAttendance = pathname.startsWith("/attendance");

  const isInventory =
    pathname === "/inventory" || pathname.startsWith("/inventory/");

  const isAdminPage = pathname === "/admin" || pathname.startsWith("/admin/");

  const adminLabel = lang === "vi" ? "Admin" : "관리자";

  return (
    <>
      <nav style={navWrapStyle}>
        <Link
          href="/inventory"
          style={isInventory ? activeItemStyle() : inactiveItemStyle()}
        >
          <span style={iconStyle}>📦</span>
          <span>{t.inventory}</span>
        </Link>

        <button
          type="button"
          disabled
          style={disabledItemStyle()}
        >
          <span style={iconStyle} aria-hidden="true">🏪</span>
          <span>{t.operation}</span>
        </button>

        {canUseAdmin && (
          <Link href="/admin" style={adminItemStyle(isAdminPage)}>
            <span style={adminCircleStyle(isAdminPage)}>
              <AdminIcon />
            </span>
            <span>{adminLabel}</span>
          </Link>
        )}

        <Link
          href="/attendance"
          style={isAttendance ? activeItemStyle() : inactiveItemStyle()}
        >
          <span style={iconStyle}>🕒</span>
          <span>{t.attendance}</span>
        </Link>

        <div style={inactiveItemStyle()}>
          <span style={iconStyle}>📢</span>
          <span>{t.notice}</span>
        </div>
      </nav>

      {/* <div style={{ height: 60 }} /> */}
    </>
  );
}
