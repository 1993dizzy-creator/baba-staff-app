"use client";
/* eslint-disable @next/next/no-img-element -- previews use blob/private signed URLs */

import { useCallback, useEffect, useRef, useState } from "react";
import { BAR_COLORS, BAR_COLOR_KEYS, type BarColorKey } from "@/lib/bar/colors";
import { BarImageCompressionError, compressBarZoneImage } from "@/lib/bar/image-compression";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";
import type { BarStaffOption, BarZoneRecord } from "@/lib/bar/types";

type Labels = Record<
  | "editZone"
  | "photo"
  | "note"
  | "assignee"
  | "assigneeColor"
  | "noAssignee"
  | "inactiveEmployee"
  | "save"
  | "saving"
  | "cancel"
  | "replacePhoto"
  | "takePhoto"
  | "deletePhoto"
  | "confirmDeletePhoto"
  | "conflict"
  | "saveError"
  | "photoError"
  | "unsupportedPhoto",
  string
>;

export default function BarZoneEditModal({ zone, staff, canAssign, lang, labels, onClose, onSaved, returnFocusRef }: {
  zone: BarZoneRecord;
  staff: BarStaffOption[];
  canAssign: boolean;
  lang: "ko" | "vi";
  labels: Labels;
  onClose: () => void;
  onSaved: () => Promise<void>;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [note, setNote] = useState(lang === "vi" ? zone.noteVi ?? "" : zone.noteKo ?? "");
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
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", key);
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = oldOverflow;
      window.removeEventListener("keydown", key);
      focusTarget?.focus();
    };
  }, [onClose, returnFocusRef]);

  useEffect(() => () => {
    if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview);
  }, [preview]);

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
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      let version = zone.version;
      const patchBody: Record<string, unknown> = {
        version,
        [lang === "vi" ? "noteVi" : "noteKo"]: note,
      };
      if (canAssign) {
        const nextAssigneeId = assigneeId ? Number(assigneeId) : null;
        const currentAssigneeId = zone.assignee?.id ?? null;
        const assignmentChanged = nextAssigneeId !== currentAssigneeId;
        if (assignmentChanged) patchBody.assigneeUserId = nextAssigneeId;
        if (nextAssigneeId && (assignmentChanged || colorKey !== zone.assignee?.colorKey)) {
          patchBody.colorKey = colorKey;
        }
      }

      const patchResponse = await fetch(`/api/bar/zones/${zone.code}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (await handleBarApiUnauthorized(patchResponse)) return;
      const patchResult = await patchResponse.json();
      if (patchResponse.status === 409) {
        window.alert(labels.conflict);
        await onSaved();
        onClose();
        return;
      }
      if (!patchResponse.ok) throw new Error(patchResult.error || labels.saveError);
      version = patchResult.version ?? version;

      if (photo) {
        const form = new FormData();
        form.set("file", photo);
        form.set("version", String(version));
        const response = await fetch(`/api/bar/zones/${zone.code}/photo`, { method: "POST", body: form });
        if (await handleBarApiUnauthorized(response)) return;
        const result = await response.json();
        if (response.status === 409) {
          window.alert(labels.conflict);
          await onSaved();
          onClose();
          return;
        }
        if (!response.ok) throw new Error(result.error || labels.photoError);
      }

      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : labels.saveError);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  async function removePhoto() {
    if (!zone.imagePath || !window.confirm(labels.confirmDeletePhoto)) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/bar/zones/${zone.code}/photo`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: zone.version }),
      });
      if (await handleBarApiUnauthorized(response)) return;
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || labels.photoError);
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : labels.photoError);
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="bar-zone-edit-title" onClick={() => !savingRef.current && onClose()} style={overlayStyle}>
      <form
        onSubmit={(event) => { event.preventDefault(); void save(); }}
        onClick={(event) => event.stopPropagation()}
        style={modalStyle}
      >
        <header style={headerStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: "#9ca3af", fontSize: 11, fontWeight: 700, lineHeight: 1.3 }}>{labels.editZone}</div>
            <h2 id="bar-zone-edit-title" style={{ margin: "3px 0 0", color: "#111827", fontSize: 17, fontWeight: 700, lineHeight: 1.35 }}>{zone.code}</h2>
          </div>
          <button ref={closeRef} type="button" disabled={saving} onClick={onClose} aria-label={labels.cancel} style={iconButtonStyle}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div style={contentStyle}>
          <section style={sectionStyle}>
            <div style={sectionLabelStyle}>{labels.photo}</div>
            {preview ? (
              <div style={{ overflow: "hidden", border: "1px solid #e5e7eb", borderRadius: 10, background: "#f9fafb" }}>
                <img src={preview} alt={`${zone.code} preview`} style={{ display: "block", width: "100%", maxHeight: 230, objectFit: "contain" }} />
              </div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
              <label style={secondaryActionStyle}>
                <PhotoIcon />
                <span>{labels.replacePhoto}</span>
                <input type="file" accept="image/*,.heic,.heif" hidden disabled={saving} onClick={(event) => { event.currentTarget.value = ""; }} onChange={(event) => void choosePhoto(event.target.files?.[0])} />
              </label>
              <label style={secondaryActionStyle}>
                <CameraIcon />
                <span>{labels.takePhoto}</span>
                <input type="file" accept="image/*" capture="environment" hidden disabled={saving} onClick={(event) => { event.currentTarget.value = ""; }} onChange={(event) => void choosePhoto(event.target.files?.[0])} />
              </label>
            </div>
            {zone.imagePath ? (
              <button type="button" disabled={saving} onClick={() => void removePhoto()} style={dangerButtonStyle}>
                {labels.deletePhoto}
              </button>
            ) : null}
          </section>

          <label style={fieldStyle}>
            <span style={fieldLabelStyle}>{labels.note}</span>
            <textarea value={note} maxLength={3000} onChange={(event) => setNote(event.target.value)} style={textareaStyle} />
          </label>

          {canAssign ? (
            <section style={sectionStyle}>
              <label style={fieldStyle}>
                <span style={fieldLabelStyle}>{labels.assignee}</span>
                <select
                  value={assigneeId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setAssigneeId(id);
                    const person = staff.find((item) => String(item.id) === id);
                    setColorKey(person?.colorKey ?? "blue");
                  }}
                  style={inputStyle}
                >
                  <option value="">{labels.noAssignee}</option>
                  {zone.assignee && !zone.assignee.isActive && !staff.some((person) => person.id === zone.assignee?.id) ? (
                    <option value={zone.assignee.id} disabled>{zone.assignee.name} · {labels.inactiveEmployee}</option>
                  ) : null}
                  {staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select>
              </label>

              {assigneeId ? (
                <div>
                  <div style={fieldLabelStyle}>{labels.assigneeColor}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 7, marginTop: 7 }}>
                    {BAR_COLOR_KEYS.map((key) => {
                      const selected = colorKey === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setColorKey(key)}
                          style={{ minHeight: 42, padding: "6px 4px", border: selected ? "1.5px solid #111827" : "1px solid #e5e7eb", borderRadius: 9, background: selected ? "#f3f4f6" : "#fff", color: "#4b5563", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, fontSize: 10, fontWeight: selected ? 700 : 600, cursor: "pointer", boxShadow: selected ? "0 0 0 2px rgba(17,24,39,.08)" : "none" }}
                        >
                          <span aria-hidden="true" style={{ width: 16, height: 16, borderRadius: 999, background: BAR_COLORS[key].css, boxShadow: "inset 0 0 0 1px rgba(0,0,0,.1)" }} />
                          <span>{lang === "vi" ? BAR_COLORS[key].labelVi : BAR_COLORS[key].labelKo}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {error ? <p role="alert" style={{ margin: 0, padding: "9px 10px", borderRadius: 8, background: "#fef2f2", color: "#b91c1c", fontSize: 12, fontWeight: 600, lineHeight: 1.45 }}>{error}</p> : null}
        </div>

        <footer style={footerStyle}>
          <button type="button" disabled={saving} onClick={onClose} style={cancelButtonStyle}>{labels.cancel}</button>
          <button type="submit" disabled={saving} style={{ ...saveButtonStyle, opacity: saving ? 0.65 : 1 }}>{saving ? labels.saving : labels.save}</button>
        </footer>
      </form>
    </div>
  );
}

function PhotoIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" /><circle cx="9" cy="10" r="2" stroke="currentColor" strokeWidth="1.7" /><path d="m4 17 5-4 3 2 3-3 5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CameraIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.7" /></svg>;
}

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 1400, padding: 12, background: "rgba(15,23,42,.68)", display: "flex", alignItems: "center", justifyContent: "center" };
const modalStyle: React.CSSProperties = { width: "100%", maxWidth: 540, maxHeight: "92vh", overflow: "hidden", borderRadius: 15, background: "#fff", boxShadow: "0 24px 70px rgba(15,23,42,.3)", display: "flex", flexDirection: "column" };
const headerStyle: React.CSSProperties = { flex: "0 0 auto", padding: "15px 16px 13px", borderBottom: "1px solid #eef0f3", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 };
const contentStyle: React.CSSProperties = { minHeight: 0, overflowY: "auto", padding: 16, display: "grid", gap: 16, WebkitOverflowScrolling: "touch" };
const sectionStyle: React.CSSProperties = { padding: 12, border: "1px solid #e5e7eb", borderRadius: 11, background: "#fff", display: "grid", gap: 10 };
const sectionLabelStyle: React.CSSProperties = { color: "#374151", fontSize: 12, fontWeight: 700, lineHeight: 1.4 };
const fieldStyle: React.CSSProperties = { display: "grid", gap: 6 };
const fieldLabelStyle: React.CSSProperties = { color: "#4b5563", fontSize: 12, fontWeight: 700, lineHeight: 1.4 };
const inputStyle: React.CSSProperties = { width: "100%", minHeight: 42, padding: "0 11px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#111827", fontSize: 13, outline: "none" };
const textareaStyle: React.CSSProperties = { ...inputStyle, minHeight: 96, padding: "10px 11px", resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 };
const iconButtonStyle: React.CSSProperties = { flex: "0 0 auto", width: 38, height: 38, padding: 0, border: "1px solid #e5e7eb", borderRadius: 10, background: "#fff", color: "#6b7280", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" };
const secondaryActionStyle: React.CSSProperties = { minHeight: 42, padding: "7px 8px", border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#374151", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, textAlign: "center", fontSize: 12, fontWeight: 650, lineHeight: 1.25, cursor: "pointer" };
const dangerButtonStyle: React.CSSProperties = { minHeight: 38, padding: "6px 10px", border: "1px solid #fecaca", borderRadius: 9, background: "#fff", color: "#b91c1c", fontSize: 12, fontWeight: 650, cursor: "pointer" };
const footerStyle: React.CSSProperties = { flex: "0 0 auto", padding: "12px 16px calc(12px + env(safe-area-inset-bottom))", borderTop: "1px solid #eef0f3", background: "#fff", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 };
const cancelButtonStyle: React.CSSProperties = { minHeight: 43, border: "1px solid #d1d5db", borderRadius: 9, background: "#fff", color: "#374151", fontSize: 13, fontWeight: 700, cursor: "pointer" };
const saveButtonStyle: React.CSSProperties = { minHeight: 43, border: "1px solid #111827", borderRadius: 9, background: "#111827", color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" };
