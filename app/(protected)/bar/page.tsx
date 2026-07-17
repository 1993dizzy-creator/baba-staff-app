"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import BarZoneDetail from "@/components/bar/BarZoneDetail";
import BarZoneEditModal from "@/components/bar/BarZoneEditModal";
import BarZoneMap, { type BarZoneMapLabels } from "@/components/bar/BarZoneMap";
import BarZoneMapModal from "@/components/bar/BarZoneMapModal";
import BarZoneOverviewLogs from "@/components/bar/BarZoneOverviewLogs";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import { canAssignBarZone, canEditBarZone } from "@/lib/bar/permissions";
import type { BarZoneDefinition } from "@/lib/bar/zone-map";
import type { BarStaffOption, BarZoneRecord } from "@/lib/bar/types";
import { useLanguage } from "@/lib/language-context";
import { getUser } from "@/lib/supabase/auth";
import { barText } from "@/lib/text/bar";
import { ui } from "@/lib/styles/ui";

export default function BarAreaPage() {
  const { lang } = useLanguage();
  const t = barText[lang];
  const [selectedZone, setSelectedZone] = useState<BarZoneDefinition | null>(null);
  const [zones, setZones] = useState<BarZoneRecord[]>([]);
  const [staff, setStaff] = useState<BarStaffOption[]>([]);
  const [loadError, setLoadError] = useState("");
  const [isMapModalOpen, setIsMapModalOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [recentLogsRefreshKey, setRecentLogsRefreshKey] = useState(0);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const [user, setUser] = useState<ReturnType<typeof getUser>>(null);
  const [userReady, setUserReady] = useState(false);
  const mayEdit = canEditBarZone(user);
  const mayAssign = canAssignBarZone(user);
  const zoneData = useMemo(() => Object.fromEntries(zones.map((zone) => [zone.code, zone])), [zones]);
  const selectedData = selectedZone ? zoneData[selectedZone.code] ?? null : null;
  const closeMapModal = useCallback(() => setIsMapModalOpen(false), []);
  const closeEditModal = useCallback(() => setIsEditOpen(false), []);

  const loadData = useCallback(async () => {
    setLoadError("");
    try {
      const requests: Promise<Response>[] = [fetch("/api/bar/zones", { cache: "no-store" })];
      if (mayAssign) requests.push(fetch("/api/bar/staff", { cache: "no-store" }));
      const [zonesResponse, staffResponse] = await Promise.all(requests);
      if (await handleBarApiUnauthorized(zonesResponse)) return;
      if (!zonesResponse.ok) throw new Error(t.loadError);
      const zonesResult = await zonesResponse.json();
      setZones(zonesResult.zones ?? []);
      if (staffResponse) {
        if (await handleBarApiUnauthorized(staffResponse)) return;
        if (!staffResponse.ok) throw new Error(t.loadError);
        setStaff((await staffResponse.json()).staff ?? []);
      }
    } catch (error) { setLoadError(error instanceof Error ? error.message : t.loadError); }
  }, [mayAssign, t.loadError]);

  const handleSaved = useCallback(async () => {
    await loadData();
    setRecentLogsRefreshKey((current) => current + 1);
  }, [loadData]);

  useEffect(() => { setUser(getUser()); setUserReady(true); }, []);
  useEffect(() => { if (userReady) void loadData(); }, [loadData, userReady]);
  const mapLabels: BarZoneMapLabels = { upper: t.upper, middle: t.middle, lower: t.lower, leftShort: t.leftShort, rightShort: t.rightShort, unavailable: t.unavailable, equipmentShort: t.equipmentShort, mapAriaLabel: t.mapAriaLabel };

  return <div style={{ minWidth: 0, maxWidth: "100%", padding: "0 0 24px" }}>
    <section style={{ minWidth: 0, padding: 0, marginBottom: 8, border: "1px solid #dcdfe4", borderRadius: 10, overflow: "hidden" }}>
      <BarZoneMap selectedCode={selectedZone?.code ?? null} onSelect={setSelectedZone} labels={mapLabels} lang={lang} zoneData={zoneData} />
    </section>
    <button ref={expandButtonRef} type="button" onClick={() => setIsMapModalOpen(true)} style={{ ...ui.subButton, minHeight: 48, marginBottom: 14, border: 0, background: "#111827", color: "#fff", fontWeight: 800 }}><span aria-hidden="true" style={{ marginRight: 6 }}>🔍</span>{t.enlargeMap}</button>
    {loadError ? <p role="alert" style={{ color: "#b91c1c", fontSize: 13, fontWeight: 700 }}>{loadError}</p> : null}
    <BarZoneDetail zone={selectedZone} data={selectedData} lang={lang} canEdit={mayEdit && Boolean(selectedData)} onEdit={() => setIsEditOpen(true)} editButtonRef={editButtonRef} recentLogsRefreshKey={recentLogsRefreshKey} text={{ selectZone: t.selectZone, keepingUnavailable: t.keepingUnavailable, noZoneInfo: t.noZoneInfo, photo: t.photo, note: t.note, assignee: t.assignee, inactiveEmployee: t.inactiveEmployee, editZone: t.editZone, photoUpdated: t.photoUpdated, recentLogs: t.recentLogs, recentLogsEmpty: t.recentLogsEmpty, recentLogsLoading: t.recentLogsLoading, recentLogsError: t.recentLogsError, retry: t.retry, viewAllLogs: t.viewAllLogs }} />
    {!selectedZone ? <BarZoneOverviewLogs lang={lang} text={{ title: t.allZoneRecentLogs, loading: t.recentLogsLoading, empty: t.allZoneLogsEmpty, error: t.recentLogsError, retry: t.retry, viewAll: t.viewAllLogs }} /> : null}
    {isMapModalOpen ? <BarZoneMapModal selectedCode={selectedZone?.code ?? null} onSelect={setSelectedZone} onClose={closeMapModal} labels={mapLabels} lang={lang} closeLabel={t.close} returnFocusRef={expandButtonRef} zoneData={zoneData} /> : null}
    {isEditOpen && selectedData ? <BarZoneEditModal zone={selectedData} staff={staff} canAssign={mayAssign} lang={lang} labels={{ editZone: t.editZone, photo: t.photo, note: t.note, assignee: t.assignee, assigneeColor: t.assigneeColor, noAssignee: t.noAssignee, inactiveEmployee: t.inactiveEmployee, save: t.save, saving: t.saving, cancel: t.cancel, replacePhoto: t.replacePhoto, takePhoto: t.takePhoto, deletePhoto: t.deletePhoto, confirmDeletePhoto: t.confirmDeletePhoto, conflict: t.conflict, saveError: t.saveError, photoError: t.photoError, unsupportedPhoto: t.unsupportedPhoto }} onClose={closeEditModal} onSaved={handleSaved} returnFocusRef={editButtonRef} /> : null}
  </div>;
}
