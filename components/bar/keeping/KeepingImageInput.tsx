"use client";
/* eslint-disable @next/next/no-img-element -- local object URL preview */
import { useEffect, useRef, useState } from "react";
import { BarImageCompressionError, compressKeepingImage } from "@/lib/bar/keeping-image-compression";
import { keepingDetailText, keepingImageErrorText, keepingText } from "@/lib/text/bar-keeping";

export type KeepingImageFiles = { detail: File; thumbnail: File; preview: string };

export default function KeepingImageInput({ lang, onChange, onBusyChange, required = false, disabled = false, currentUrl = null }: {
  lang: "ko" | "vi"; onChange: (files: KeepingImageFiles | null) => void; onBusyChange?: (busy: boolean) => void;
  required?: boolean; disabled?: boolean; compact?: boolean; currentUrl?: string | null;
}) {
  const t = keepingText[lang], dt = keepingDetailText[lang], imageError = keepingImageErrorText[lang];
  const [preview, setPreview] = useState<string | null>(currentUrl), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const url = useRef<string | null>(null), request = useRef(0);
  useEffect(() => () => { request.current += 1; if (url.current) URL.revokeObjectURL(url.current); }, []);
  const setWorking = (value: boolean) => { setBusy(value); onBusyChange?.(value); };

  async function choose(file?: File) {
    if (!file || busy || disabled) return;
    const requestId = ++request.current;
    setWorking(true); setError("");
    try {
      const result = await compressKeepingImage(file);
      if (requestId !== request.current) return;
      const nextUrl = URL.createObjectURL(result.detail);
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = nextUrl; setPreview(nextUrl); onChange({ ...result, preview: nextUrl });
    } catch (caught) {
      if (requestId !== request.current) return;
      const code = caught instanceof BarImageCompressionError ? caught.code : "compression_failed";
      setError(code === "unsupported_format" ? imageError.unsupported : code === "too_large" ? imageError.tooLarge : imageError.processingFailed);
      // Keep the last successfully selected files and preview intact.
    } finally {
      if (requestId === request.current) setWorking(false);
    }
  }

  const action = (camera: boolean) => <label style={{ minHeight: 43, padding: "7px 9px", border: "1px solid #d1d5db", borderRadius: 10, background: "#fff", color: "#374151", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 700, opacity: busy || disabled ? 0.6 : 1 }}>
    {camera ? <Camera /> : <Photo />}<span>{camera ? t.camera : t.album}</span>
    {camera
      ? <input hidden type="file" accept="image/*" capture="environment" disabled={busy || disabled} onClick={event => { event.currentTarget.value = ""; }} onChange={event => void choose(event.target.files?.[0])} />
      : <input hidden type="file" accept="image/*,.heic,.heif" disabled={busy || disabled} onClick={event => { event.currentTarget.value = ""; }} onChange={event => void choose(event.target.files?.[0])} />}
  </label>;

  return <div>
    <div style={{ color: "#4b5563", fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{t.photo}{required ? " *" : ""}</div>
    {preview ? <div style={{ display: "grid", gridTemplateColumns: "72px minmax(0,1fr)", gap: 10, alignItems: "center", marginBottom: 8 }}><div style={{ width: 72, height: 92, border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", background: "#f3f4f6" }}><img src={preview} alt={t.photo} style={{ width: "100%", height: "100%", objectFit: "contain" }} /></div><div style={{ minWidth: 0, color: "#6b7280", fontSize: 11, lineHeight: 1.45 }}>{busy ? t.loading : dt.photoSelected}</div></div> : null}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>{action(true)}{action(false)}</div>
    {busy ? <p aria-live="polite" style={{ margin: "6px 0 0", fontSize: 11, color: "#6b7280" }}>{t.loading}</p> : null}
    {error ? <p role="alert" style={{ margin: "6px 0 0", fontSize: 11, color: "#b91c1c" }}>{error}</p> : null}
  </div>;
}

function Camera() { return <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 7h3l1.5-2h7L17 7h3v12H4V7Z" stroke="currentColor" strokeWidth="1.7" /><circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.7" /></svg>; }
function Photo() { return <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" /><path d="m4 17 5-4 3 2 3-3 5 5" stroke="currentColor" strokeWidth="1.7" /></svg>; }
