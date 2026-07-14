"use client";
/* eslint-disable @next/next/no-img-element -- private signed URLs bypass the public Next image optimizer */

import { useRef, useState } from "react";
import ImagePreviewModal from "@/components/bar/ImagePreviewModal";
import type { BarZoneDefinition } from "@/lib/bar/zone-map";
import type { BarZoneRecord } from "@/lib/bar/types";
import { ui } from "@/lib/styles/ui";

type Text = { selectZone: string; selectedZone: string; keepingUnavailable: string; noZoneInfo: string; photo: string; assignee: string; inactiveEmployee: string; editZone: string; close: string };

export default function BarZoneDetail({ zone, data, lang, text, canEdit, onEdit, editButtonRef }: {
  zone: BarZoneDefinition | null; data: BarZoneRecord | null; lang: "ko" | "vi"; text: Text;
  canEdit: boolean; onEdit: () => void; editButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const imageButtonRef = useRef<HTMLButtonElement>(null);
  if (!zone) return <section aria-live="polite" style={{ ...ui.card, minHeight: 112, padding: 20, display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280", fontWeight: 800, textAlign: "center" }}>{text.selectZone}</section>;
  const label = lang === "vi" ? zone.labelVi : zone.labelKo;
  const note = lang === "vi" ? data?.noteVi || data?.noteKo : data?.noteKo || data?.noteVi;
  const hasInfo = Boolean(data?.imageUrl || note || data?.assignee);
  return (
    <section aria-live="polite" style={{ ...ui.card, padding: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div><div style={{ color: "#6b7280", fontSize: 12, fontWeight: 800 }}>{text.selectedZone}</div><h2 style={{ margin: "5px 0 0", color: "#111827", fontSize: 20 }}>{label}</h2></div>
        {canEdit ? <button ref={editButtonRef} type="button" onClick={onEdit} aria-label={text.editZone} title={text.editZone} style={{ width: 44, height: 44, border: "1px solid #d1d5db", borderRadius: 10, background: "#fff", fontSize: 21, cursor: "pointer" }}>⚙</button> : null}
      </div>
      {!zone.selectableForKeeping ? <div style={{ marginTop: 12, padding: "9px 11px", border: "1px solid #fbbf24", borderRadius: 10, background: "#fffbeb", color: "#92400e", fontSize: 13, fontWeight: 900 }}>{text.keepingUnavailable}</div> : null}
      {!hasInfo ? <p style={{ margin: "16px 0 0", color: "#6b7280", fontSize: 14 }}>{text.noZoneInfo}</p> : (
        <div style={{ display: "grid", gap: 14, marginTop: 16 }}>
          {data?.imageUrl ? <button ref={imageButtonRef} type="button" onClick={() => setPreviewOpen(true)} style={{ padding: 0, border: 0, borderRadius: 12, overflow: "hidden", background: "#f3f4f6", cursor: "zoom-in" }}>{/* Signed private Storage URLs are intentionally rendered without the Next image optimizer. */}<img src={data.imageUrl} alt={`${label} ${text.photo}`} style={{ display: "block", width: "100%", maxHeight: 360, objectFit: "contain" }} /></button> : null}
          {note ? <p style={{ margin: 0, padding: 13, borderRadius: 10, background: "#f3f4f6", color: "#374151", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{note}</p> : null}
          {data?.assignee ? <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#374151", fontWeight: 800 }}><span>{text.assignee}: {data.assignee.name}</span>{!data.assignee.isActive ? <span style={{ padding: "3px 7px", borderRadius: 999, background: "#fee2e2", color: "#991b1b", fontSize: 11 }}>{text.inactiveEmployee}</span> : null}</div> : null}
        </div>
      )}
      {previewOpen && data?.imageUrl ? <ImagePreviewModal src={data.imageUrl} alt={label} closeLabel={text.close} onClose={() => { setPreviewOpen(false); requestAnimationFrame(() => imageButtonRef.current?.focus()); }} /> : null}
    </section>
  );
}
