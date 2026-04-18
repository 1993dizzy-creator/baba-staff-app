"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLanguage } from "@/lib/language-context";

export default function InventorySubNav() {
  const pathname = usePathname();
  const { lang } = useLanguage();

  const tabs = [
    {
      href: "/inventory",
      label: lang === "vi" ? "Tồn kho" : "재고관리",
      active:
        pathname === "/inventory" ||
        pathname === "/inventory/",
    },
    {
      href: "/inventory/logs",
      label: lang === "vi" ? "Log" : "재고로그",
      active: pathname.startsWith("/inventory/logs"),
    },
    {
      href: "/inventory/snapshots",
      label: lang === "vi" ? "Theo ngày" : "일자별재고",
      active: pathname.startsWith("/inventory/snapshots"),
    },
  ];

  return (
    <div
      style={{
        borderBottom: "1px solid #e5e7eb",
        marginBottom: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-around",
        }}
      >
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "12px 0 10px",
              fontSize: 14,
              fontWeight: tab.active ? 800 : 600,
              color: tab.active ? "#111827" : "#9ca3af",
              textDecoration: "none",
              borderBottom: tab.active
                ? "3px solid #111827"
                : "3px solid transparent",
            }}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </div>
  );
}