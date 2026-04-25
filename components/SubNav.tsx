"use client";

import Link from "next/link";

type SubNavTab = {
  href: string;
  label: string;
  active: boolean;
};

export default function SubNav({
  tabs = [],
}: {
  tabs?: SubNavTab[];
}) {
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