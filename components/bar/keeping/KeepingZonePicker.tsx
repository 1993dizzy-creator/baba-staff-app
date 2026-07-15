"use client";
import { useEffect, useState } from "react";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import type { BarZoneRecord } from "@/lib/bar/types";
import { barZones } from "@/lib/bar/zone-map";
import { keepingText } from "@/lib/text/bar-keeping";

export default function KeepingZonePicker({ value, onChange, lang, excludeCode, disabled }: { value: string; onChange: (code: string) => void; lang: "ko" | "vi"; excludeCode?: string; disabled?: boolean }) {
  const t = keepingText[lang]; const [zones, setZones] = useState<BarZoneRecord[]>([]); const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/bar/zones", { cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (await handleBarApiUnauthorized(response)) return null;
      if (!response.ok) throw new Error(t.error); return response.json();
    }).then((result) => { if (result) setZones((result.zones ?? []).filter((zone: BarZoneRecord) => zone.isActive && zone.selectableForKeeping && zone.code !== excludeCode)); })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : t.error); });
    return () => controller.abort();
  }, [excludeCode, t.error]);
  return <div><div style={{ fontSize: 12, fontWeight: 700, marginBottom: 7 }}>{t.selectZone}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>{barZones.filter((definition) => zones.some((zone) => zone.code === definition.code)).map((definition) => <button type="button" disabled={disabled} key={definition.code} title={lang === "vi" ? definition.labelVi : definition.labelKo} onClick={() => onChange(definition.code)} style={{ minWidth: 50, minHeight: 42, border: value === definition.code ? "2px solid #111827" : "1px solid #d1d5db", borderRadius: 9, background: "#fff", fontWeight: 800 }}>{definition.code}</button>)}</div>{error ? <p role="alert" style={{ color: "#b91c1c", fontSize: 12 }}>{error}</p> : null}</div>;
}
