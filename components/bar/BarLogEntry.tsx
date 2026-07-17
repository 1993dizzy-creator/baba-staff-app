import Link from "next/link";
import { formatBarDateTime, formatBarLogSummary, getBarLogNote } from "@/lib/bar/log-format";
import type { BarActivityLog } from "@/lib/bar/types";
import { ui } from "@/lib/styles/ui";

export default function BarLogEntry({ log, lang, compact = false }: { log: BarActivityLog; lang: "ko" | "vi"; compact?: boolean }) {
  const note = getBarLogNote(log);
  const target = log.entityCode || (log.entityType === "zone" ? `#${log.entityId}` : `#${log.entityId}`);
  const targetStyle: React.CSSProperties = { color: "#1f2937", fontSize: compact ? 12 : 13, fontWeight: 800, lineHeight: 1.4, overflowWrap: "anywhere", textDecoration: log.entityType === "keeping" ? "underline" : "none", textDecorationColor: "#9ca3af", textUnderlineOffset: 2 };

  return <article style={compact ? { padding: "9px 0", borderTop: "1px solid #f3f4f6" } : { ...ui.card, padding: 12 }}>
    {log.entityType === "keeping" ? <Link href={`/bar/keeping/${log.entityId}`} style={targetStyle}>{target}</Link> : <div style={targetStyle}>{target}</div>}
    <p style={{ margin: "4px 0 0", color: "#374151", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>{formatBarLogSummary(log, lang, { includeTarget: false })}</p>
    {note ? <div style={{ marginTop: 6 }}><div style={{ color: "#6b7280", fontSize: 10, fontWeight: 700 }}>{lang === "vi" ? "Ghi chú" : "비고"}</div><div style={{ marginTop: 2, color: "#374151", fontSize: 12, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{note}</div></div> : null}
    <div style={{ marginTop: 7, display: "flex", justifyContent: "flex-end", alignItems: "baseline", flexWrap: "wrap", gap: 4, color: "#9ca3af", fontSize: 10, lineHeight: 1.35, textAlign: "right" }}><span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>{log.actorName}</span><span aria-hidden>·</span><time dateTime={log.createdAt}>{formatBarDateTime(log.createdAt, lang)}</time></div>
  </article>;
}
