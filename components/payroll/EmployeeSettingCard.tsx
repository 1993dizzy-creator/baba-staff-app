"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

export default function EmployeeSettingCard({
  title,
  applied,
  vi,
  children,
}: {
  title: string;
  applied: boolean | null;
  vi: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const status = applied === null ? null : applied
    ? vi ? "Áp dụng" : "적용"
    : vi ? "Không áp dụng" : "미적용";

  return (
    <section style={s.card}>
      <button
        type="button"
        style={s.header}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <strong style={s.title}>{title}</strong>
        <span style={s.headerRight}>
          {status ? <span style={applied ? s.activeBadge : s.inactiveBadge}>{status}</span> : null}
          <span aria-hidden="true" style={s.chevron}>{open ? "⌃" : "⌄"}</span>
        </span>
      </button>
      {open ? <div style={s.body}>{children}</div> : null}
    </section>
  );
}

const s = {
  card: { border: "1px solid #e5e7eb", borderRadius: 14, background: "#fff", minWidth: 0, overflow: "hidden" },
  header: { width: "100%", minWidth: 0, minHeight: 46, padding: "10px 12px", border: 0, background: "#fff", color: "#111827", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, textAlign: "left", cursor: "pointer" },
  title: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 15, fontWeight: 900 },
  headerRight: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, flexShrink: 0 },
  activeBadge: { padding: "3px 7px", border: "1px solid #a7f3d0", borderRadius: 999, background: "#ecfdf5", color: "#047857", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" },
  inactiveBadge: { padding: "3px 7px", border: "1px solid #e5e7eb", borderRadius: 999, background: "#f9fafb", color: "#6b7280", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" },
  chevron: { width: 14, textAlign: "center", color: "#6b7280", fontSize: 15, lineHeight: 1 },
  body: { display: "grid", gap: 9, padding: "0 13px 13px", borderTop: "1px solid #f3f4f6", minWidth: 0 },
} satisfies Record<string, CSSProperties>;
