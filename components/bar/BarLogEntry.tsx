import Link from "next/link";
import { formatBarDateTime, formatBarLogSummary, getBarLogNote } from "@/lib/bar/log-format";
import type { BarActivityLog } from "@/lib/bar/types";
import { ui } from "@/lib/styles/ui";

export default function BarLogEntry({ log, lang, compact = false }: { log: BarActivityLog; lang: "ko" | "vi"; compact?: boolean }) {
  const note = getBarLogNote(log);
  const target = log.entityCode || (log.entityType === "zone" ? `#${log.entityId}` : `#${log.entityId}`);
  const targetStyle: React.CSSProperties = { color: "#1f2937", fontSize: compact ? 12 : 13, fontWeight: 800, lineHeight: 1.4, overflowWrap: "anywhere", textDecoration: log.entityType === "keeping" ? "underline" : "none", textDecorationColor: "#9ca3af", textUnderlineOffset: 2 };

  return <article style={compact ? { padding: "9px 0", borderTop: "1px solid #f3f4f6" } : { ...ui.card, padding: 12 }}>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start", gap: 8 }}>
      {log.entityType === "keeping" ? <Link href={`/bar/keeping/${log.entityId}`} style={{ ...targetStyle, minWidth: 0 }}>{target}</Link> : <div style={{ ...targetStyle, minWidth: 0 }}>{target}</div>}
      <div style={{ minWidth: 0, maxWidth: "min(52vw, 180px)", display: "flex", justifyContent: "flex-end", alignItems: "baseline", gap: 4, color: "#9ca3af", fontSize: 10, lineHeight: 1.4, textAlign: "right", whiteSpace: "nowrap" }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{log.actorName}</span>
        <span aria-hidden style={{ flexShrink: 0 }}>·</span>
        <time dateTime={log.createdAt} style={{ flexShrink: 0 }}>{formatBarDateTime(log.createdAt, lang, true)}</time>
      </div>
    </div>
    <p style={{ margin: "4px 0 0", color: "#374151", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>{formatBarLogSummary(log, lang, { includeTarget: false })}</p>
    {note ? <div style={{ marginTop: 5, color: "#374151", fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}><strong style={{ color: "#6b7280", fontSize: 11 }}>{lang === "vi" ? "Ghi chú" : "비고"}</strong> · {note}</div> : null}
  </article>;
}
