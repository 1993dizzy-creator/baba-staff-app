"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/lib/language-context";
import { layoutText } from "@/lib/text/layout";

const navWrapStyle: React.CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  height: 56,
  background: "#111827",
  borderTop: "1px solid #1f2937",
  display: "flex",
  justifyContent: "space-around",
  alignItems: "stretch",
  zIndex: 1000,
  boxShadow: "0 -6px 18px rgba(0,0,0,0.16)",
};

const baseItem: React.CSSProperties = {
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

const iconStyle: React.CSSProperties = {
  fontSize: 18,
  lineHeight: 1,
};

function activeItemStyle(): React.CSSProperties {
  return {
    ...baseItem,
    color: "#ffffff",
    background: "#1f2937",
  };
}

function inactiveItemStyle(): React.CSSProperties {
  return {
    ...baseItem,
    color: "#9ca3af",
    background: "transparent",
  };
}

export default function BottomNav() {
  const pathname = usePathname();
  const { lang } = useLanguage();
  const t = layoutText[lang];

  const isInventory =
    pathname === "/inventory" || pathname.startsWith("/inventory/");

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

        <div style={inactiveItemStyle()}>
          <span style={iconStyle}>💰</span>
          <span>{t.sales}</span>
        </div>

        <div style={inactiveItemStyle()}>
          <span style={iconStyle}>🕒</span>
          <span>{t.attendance}</span>
        </div>

        <div style={inactiveItemStyle()}>
          <span style={iconStyle}>📢</span>
          <span>{t.notice}</span>
        </div>
      </nav>

      {/* <div style={{ height: 56 }} /> */}
    </>
  );
}