"use client";
/* eslint-disable @next/next/no-img-element -- private signed URLs bypass the public Next image optimizer */

import type { BarZoneDefinition } from "@/lib/bar/zone-map";
import type { BarZoneRecord } from "@/lib/bar/types";
import { formatBarDateTime } from "@/lib/bar/log-format";
import { ui } from "@/lib/styles/ui";
import BarZoneRecentLogs from "@/components/bar/BarZoneRecentLogs";
import ZoneKeepingSummary from "@/components/bar/keeping/ZoneKeepingSummary";

type Text = {
  selectZone: string;
  keepingUnavailable: string;
  noZoneInfo: string;
  photo: string;
  note: string;
  assignee: string;
  inactiveEmployee: string;
  editZone: string;
  photoUpdated: string;
  recentLogs: string;
  recentLogsEmpty: string;
  recentLogsLoading: string;
  recentLogsError: string;
  retry: string;
  viewAllLogs: string;
};

export default function BarZoneDetail({ zone, data, lang, text, canEdit, onEdit, editButtonRef, recentLogsRefreshKey }: {
  zone: BarZoneDefinition | null;
  data: BarZoneRecord | null;
  lang: "ko" | "vi";
  text: Text;
  canEdit: boolean;
  onEdit: () => void;
  editButtonRef: React.RefObject<HTMLButtonElement | null>;
  recentLogsRefreshKey: number;
}) {
  if (!zone) {
    return (
      <section aria-live="polite" style={{ ...ui.card, minHeight: 96, padding: 18, display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280", fontSize: 13, fontWeight: 600, textAlign: "center" }}>
        {text.selectZone}
      </section>
    );
  }

  const label = lang === "vi" ? zone.labelVi : zone.labelKo;
  const note = lang === "vi" ? data?.noteVi || data?.noteKo : data?.noteKo || data?.noteVi;
  const hasInfo = Boolean(data?.imageUrl || note || data?.assignee);
  const photoUpdatedAt = data?.imageUrl && data.imageUpdatedAt
    ? formatBarDateTime(data.imageUpdatedAt, lang)
    : null;

  return (
    <section aria-live="polite" style={{ ...ui.card, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 style={{ minWidth: 0, margin: 0, color: "#111827", fontSize: 16, fontWeight: 700, lineHeight: 1.35 }}>
          {label}
        </h2>
        {canEdit ? (
          <button
            ref={editButtonRef}
            type="button"
            onClick={onEdit}
            aria-label={text.editZone}
            title={text.editZone}
            style={{ flex: "0 0 auto", width: 38, height: 38, padding: 0, border: "1px solid #d1d5db", borderRadius: 10, background: "#fff", color: "#4b5563", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
          >
            <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none">
              <path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="m14 8 3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>

      {!zone.selectableForKeeping ? (
        <div style={{ marginTop: 10, padding: "8px 10px", border: "1px solid #fcd34d", borderRadius: 9, background: "#fffbeb", color: "#92400e", fontSize: 12, fontWeight: 700, lineHeight: 1.4 }}>
          {text.keepingUnavailable}
        </div>
      ) : null}

      {!hasInfo ? (
        <p style={{ margin: "14px 0 0", color: "#6b7280", fontSize: 13, lineHeight: 1.5 }}>{text.noZoneInfo}</p>
      ) : (
        <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
          {data?.imageUrl ? (
            <div>
              <div style={{ overflow: "hidden", border: "1px solid #e5e7eb", borderRadius: 11, background: "#f9fafb" }}>
                <img src={data.imageUrl} alt={`${label} ${text.photo}`} style={{ display: "block", width: "100%", maxHeight: 340, objectFit: "contain" }} />
              </div>
              {photoUpdatedAt ? <div style={{ marginTop: 6, color: "#9ca3af", fontSize: 11, lineHeight: 1.4 }}>{text.photoUpdated} · {photoUpdatedAt}</div> : null}
            </div>
          ) : null}

          {note ? (
            <div>
              <div style={{ marginBottom: 5, color: "#6b7280", fontSize: 11, fontWeight: 700 }}>{text.note}</div>
              <p style={{ margin: 0, padding: "11px 12px", borderRadius: 9, background: "#f9fafb", color: "#374151", fontSize: 13, fontWeight: 400, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{note}</p>
            </div>
          ) : null}

          {data?.assignee ? (
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 7, color: "#374151", fontSize: 13, lineHeight: 1.4 }}>
              <span style={{ color: "#6b7280", fontSize: 11, fontWeight: 700 }}>{text.assignee}</span>
              <strong style={{ fontWeight: 700 }}>{data.assignee.name}</strong>
              {!data.assignee.isActive ? <span style={{ padding: "3px 7px", borderRadius: 999, background: "#fee2e2", color: "#991b1b", fontSize: 10, fontWeight: 700 }}>{text.inactiveEmployee}</span> : null}
            </div>
          ) : null}
        </div>
      )}
      {zone.selectableForKeeping ? <ZoneKeepingSummary zoneCode={zone.code} lang={lang} refreshKey={recentLogsRefreshKey} /> : null}
      <BarZoneRecentLogs
        zoneCode={zone.code}
        lang={lang}
        refreshKey={recentLogsRefreshKey}
        text={{ recentLogs: text.recentLogs, recentLogsEmpty: text.recentLogsEmpty, recentLogsLoading: text.recentLogsLoading, recentLogsError: text.recentLogsError, retry: text.retry, viewAllLogs: text.viewAllLogs }}
      />
    </section>
  );
}
