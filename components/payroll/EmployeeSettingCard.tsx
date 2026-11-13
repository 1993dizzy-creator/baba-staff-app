"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

export default function EmployeeSettingCard({
  title,
  applied,
  vi,
  children,
  defaultOpen = false,
  bare = false,
}: {
  title: string;
  applied: boolean | null;
  vi: boolean;
  children: ReactNode;
  /** 설정 하나만 여는 모달(/admin/users)에서는 펼친 상태로 시작한다. */
  defaultOpen?: boolean;
  /**
   * /admin/users 설정 모달: 바깥 모달 제목이 있으므로 카드 제목·접기 머리글 없이 내용만 펼쳐 보여 준다.
   * 급여설정 화면(기본값 false)의 접는 카드는 그대로다.
   */
  bare?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const status = applied === null ? null : applied
    ? vi ? "Áp dụng" : "적용"
    : vi ? "Không áp dụng" : "미적용";

  if (bare) return <section style={s.bare}>{children}</section>;
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
  bare: { display: "grid", gap: 14, minWidth: 0 },
} satisfies Record<string, CSSProperties>;
