"use client";
/* eslint-disable @next/next/no-img-element -- previews use blob/private signed URLs */

import { useCallback, useEffect, useRef, useState } from "react";
import { BAR_COLORS, BAR_COLOR_KEYS, type BarColorKey } from "@/lib/bar/colors";
import { BarImageCompressionError, compressBarZoneImage } from "@/lib/bar/image-compression";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import type { BarStaffOption, BarZoneRecord } from "@/lib/bar/types";

type Labels = Record<"editZone" | "photo" | "noteKo" | "noteVi" | "assignee" | "assigneeColor" | "noAssignee" | "save" | "saving" | "cancel" | "replacePhoto" | "takePhoto" | "deletePhoto" | "confirmDeletePhoto" | "conflict" | "saveError" | "photoError" | "unsupportedPhoto", string>;

export default function BarZoneEditModal({ zone, staff, canAssign, lang, labels, onClose, onSaved, returnFocusRef }: {
  zone: BarZoneRecord; staff: BarStaffOption[]; canAssign: boolean; lang: "ko" | "vi"; labels: Labels;
  onClose: () => void; onSaved: () => Promise<void>; returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [noteKo, setNoteKo] = useState(zone.noteKo ?? "");
  const [noteVi, setNoteVi] = useState(zone.noteVi ?? "");
  const [assigneeId, setAssigneeId] = useState(zone.assignee?.id ? String(zone.assignee.id) : "");
  const [colorKey, setColorKey] = useState<BarColorKey>(zone.assignee?.colorKey ?? "blue");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(zone.imageUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const photoRequestRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      photoRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    const focusTarget = returnFocusRef.current;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !savingRef.current) onClose(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", key);
    closeRef.current?.focus();
    return () => { document.body.style.overflow = oldOverflow; window.removeEventListener("keydown", key); focusTarget?.focus(); };
  }, [onClose, returnFocusRef]);

  useEffect(() => () => { if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview); }, [preview]);

  const choosePhoto = useCallback(async (file?: File) => {
    if (!file) return;
    const requestId = ++photoRequestRef.current;
    setError("");
    try {
      const compressed = await compressBarZoneImage(file);
      if (!mountedRef.current || requestId !== photoRequestRef.current) return;
      setPhoto(compressed);
      setPreview(URL.createObjectURL(compressed));
    } catch (caught) {
      if (!mountedRef.current || requestId !== photoRequestRef.current) return;
      setError(caught instanceof BarImageCompressionError && caught.code === "unsupported_format" ? labels.unsupportedPhoto : labels.photoError);
    }
  }, [labels.photoError, labels.unsupportedPhoto]);

  async function save() {
    if (saving) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      let version = zone.version;
      const patchBody: Record<string, unknown> = { version, noteKo, noteVi };
      if (canAssign) {
        patchBody.assigneeUserId = assigneeId ? Number(assigneeId) : null;
        if (assigneeId) patchBody.colorKey = colorKey;
      }
      const patchResponse = await fetch(`/api/bar/zones/${zone.code}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patchBody) });
      if (await handleBarApiUnauthorized(patchResponse)) return;
      const patchResult = await patchResponse.json();
      if (patchResponse.status === 409) { window.alert(labels.conflict); await onSaved(); onClose(); return; }
      if (!patchResponse.ok) throw new Error(patchResult.error || labels.saveError);
      version = patchResult.version ?? version;
      if (photo) {
        const form = new FormData(); form.set("file", photo); form.set("version", String(version));
        const response = await fetch(`/api/bar/zones/${zone.code}/photo`, { method: "POST", body: form });
        if (await handleBarApiUnauthorized(response)) return;
        const result = await response.json();
        if (response.status === 409) { window.alert(labels.conflict); await onSaved(); onClose(); return; }
        if (!response.ok) throw new Error(result.error || labels.photoError);
      }
      await onSaved(); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : labels.saveError); }
    finally { savingRef.current = false; if (mountedRef.current) setSaving(false); }
  }

  async function removePhoto() {
    if (!zone.imagePath || !window.confirm(labels.confirmDeletePhoto)) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      const response = await fetch(`/api/bar/zones/${zone.code}/photo`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: zone.version }) });
      if (await handleBarApiUnauthorized(response)) return;
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || labels.photoError);
      await onSaved(); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : labels.photoError); }
    finally { savingRef.current = false; if (mountedRef.current) setSaving(false); }
  }

  return <div role="dialog" aria-modal="true" aria-labelledby="bar-zone-edit-title" onClick={() => !saving && onClose()} style={{ position: "fixed", inset: 0, zIndex: 1400, padding: 12, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center" }}>
    <div onClick={(event) => event.stopPropagation()} style={{ width: "100%", maxWidth: 560, maxHeight: "92vh", overflowY: "auto", background: "#fff", borderRadius: 16, padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}><h2 id="bar-zone-edit-title" style={{ margin: 0, fontSize: 20 }}>{labels.editZone} · {zone.code}</h2><button ref={closeRef} type="button" disabled={saving} onClick={onClose} aria-label={labels.cancel} style={iconButton}>×</button></div>
      <div style={{ display: "grid", gap: 16, marginTop: 18 }}>
        <fieldset style={fieldset}><legend style={legend}>{labels.photo}</legend>{preview ? <>{/* Blob and signed private URLs cannot use the Next image optimizer. */}<img src={preview} alt={`${zone.code} preview`} style={{ width: "100%", maxHeight: 260, objectFit: "contain", borderRadius: 10, background: "#f3f4f6" }} /></> : null}<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}><label style={fileLabel}>{labels.replacePhoto}<input type="file" accept="image/*,.heic,.heif" hidden disabled={saving} onClick={(event) => { event.currentTarget.value = ""; }} onChange={(event) => void choosePhoto(event.target.files?.[0])} /></label><label style={fileLabel}>{labels.takePhoto}<input type="file" accept="image/*" capture="environment" hidden disabled={saving} onClick={(event) => { event.currentTarget.value = ""; }} onChange={(event) => void choosePhoto(event.target.files?.[0])} /></label></div>{zone.imagePath ? <button type="button" disabled={saving} onClick={() => void removePhoto()} style={{ ...button, color: "#b91c1c" }}>{labels.deletePhoto}</button> : null}</fieldset>
        <label style={label}>{labels.noteKo}<textarea value={noteKo} maxLength={3000} onChange={(event) => setNoteKo(event.target.value)} style={textarea} /></label>
        <label style={label}>{labels.noteVi}<textarea value={noteVi} maxLength={3000} onChange={(event) => setNoteVi(event.target.value)} style={textarea} /></label>
        {canAssign ? <><label style={label}>{labels.assignee}<select value={assigneeId} onChange={(event) => { const id = event.target.value; setAssigneeId(id); const person = staff.find((item) => String(item.id) === id); if (person?.colorKey) setColorKey(person.colorKey); }} style={input}><option value="">{labels.noAssignee}</option>{staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>{assigneeId ? <fieldset style={fieldset}><legend style={legend}>{labels.assigneeColor}</legend><div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>{BAR_COLOR_KEYS.map((key) => <button key={key} type="button" aria-pressed={colorKey === key} onClick={() => setColorKey(key)} style={{ minHeight: 44, border: colorKey === key ? "3px solid #111827" : "1px solid #d1d5db", borderRadius: 9, background: BAR_COLORS[key].css, color: "#111827", fontSize: 11, fontWeight: 900 }}>{lang === "vi" ? BAR_COLORS[key].labelVi : BAR_COLORS[key].labelKo}</button>)}</div></fieldset> : null}</> : null}
      </div>
      {error ? <p role="alert" style={{ color: "#b91c1c", fontWeight: 700 }}>{error}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 20 }}><button type="button" disabled={saving} onClick={onClose} style={button}>{labels.cancel}</button><button type="button" disabled={saving} onClick={() => void save()} style={{ ...button, background: "#111827", color: "#fff" }}>{saving ? labels.saving : labels.save}</button></div>
    </div>
  </div>;
}

const fieldset: React.CSSProperties = { margin: 0, padding: 12, border: "1px solid #d1d5db", borderRadius: 10 };
const legend: React.CSSProperties = { padding: "0 5px", fontSize: 13, fontWeight: 800 };
const label: React.CSSProperties = { display: "grid", gap: 6, color: "#374151", fontSize: 13, fontWeight: 800 };
const input: React.CSSProperties = { width: "100%", minHeight: 46, padding: "0 10px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff" };
const textarea: React.CSSProperties = { ...input, minHeight: 92, padding: 10, resize: "vertical", font: "inherit" };
const button: React.CSSProperties = { minHeight: 46, border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", fontWeight: 800, cursor: "pointer" };
const iconButton: React.CSSProperties = { ...button, minWidth: 44, fontSize: 22 };
const fileLabel: React.CSSProperties = { ...button, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: 13 };
