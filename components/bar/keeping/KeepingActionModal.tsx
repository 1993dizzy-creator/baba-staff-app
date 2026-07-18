"use client";
/* eslint-disable @next/next/no-img-element -- private signed image in management modal */
import { useId, useState } from "react";
import KeepingImageInput, { type KeepingImageFiles } from "@/components/bar/keeping/KeepingImageInput";
import KeepingProductAutocomplete, { type KeepingProduct } from "@/components/bar/keeping/KeepingProductAutocomplete";
import KeepingZonePicker from "@/components/bar/keeping/KeepingZonePicker";
import { BarField, BarSection, BarSegmentedControl, BarSheet, KeepingRegistrationPercentSelector, dangerButtonStyle, keepingInputStyle, primaryButtonStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import type { BarKeeping } from "@/lib/bar/keeping-types";
import { vietnamToday } from "@/lib/bar/keeping";
import { keepingDetailText, keepingText } from "@/lib/text/bar-keeping";
import { keepingNewText } from "@/lib/text/bar-keeping-new";
import { handleBarApiUnauthorized } from "@/lib/bar/client-auth";

export type KeepingAction = "update" | "use" | "correct_remaining" | "replace_photo" | "close" | "reactivate";
type ProcessAction = "use" | "correct_remaining" | "close";
type Source = "inventory" | "external";
type Props = { item: BarKeeping; action: KeepingAction; lang: "ko" | "vi"; onClose: () => void; onSaved: () => Promise<void>; returnFocusRef?: React.RefObject<HTMLElement | null> };

export default function KeepingActionModal({ item, action, lang, onClose, onSaved, returnFocusRef }: Props) {
  const t = keepingText[lang], nt = keepingNewText[lang], dt = keepingDetailText[lang];
  const [processAction, setProcessAction] = useState<ProcessAction>(action === "correct_remaining" ? "correct_remaining" : action === "close" ? "close" : "use");
  const [zoneExpanded, setZoneExpanded] = useState(false); const zonePanelId = useId();
  const effectiveAction: KeepingAction = action === "use" ? processAction : action;
  const [image, setImage] = useState<KeepingImageFiles | null>(null), [imageBusy, setImageBusy] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const initialSource: Source = item.liquorSource ?? "external";
  const [source, setSource] = useState<Source>(initialSource), [product, setProduct] = useState<KeepingProduct | null>(item.inventoryItemId ? { id: item.inventoryItemId, item_name: item.liquorName, item_name_vi: null, code: null, category: null, category_vi: null } : null);
  const [values, setValues] = useState<Record<string, string | boolean>>({ customerName: item.customerName, customerContact: item.customerContact ?? "", customerIdentifier: item.customerIdentifier ?? "", liquorName: item.liquorName, note: item.note ?? "", actionNote: "", storedAt: action === "reactivate" ? vietnamToday() : item.storedAt, remainingPercent: String(item.remainingPercent), usedAt: localDateTime(new Date()), zoneCode: item.zoneCode, finish: item.remainingPercent === 0, closeReason: "finished", closedAt: localDateTime(new Date()) });
  const set = (key: string, value: string | boolean) => setValues(current => ({ ...current, [key]: value }));
  const zoneChanged = action === "update" && item.status === "active" && values.zoneCode !== item.zoneCode;
  const informationChanged = action === "update" && (String(values.customerName).trim() !== item.customerName || String(values.customerContact).trim() !== (item.customerContact ?? "") || String(values.customerIdentifier).trim() !== (item.customerIdentifier ?? "") || source !== initialSource || (source === "inventory" ? product?.id !== item.inventoryItemId : String(values.liquorName).trim() !== item.liquorName) || String(values.note).trim() !== (item.note ?? "") || values.storedAt !== item.storedAt);
  const selectUpdateZone = (code: string) => { set("zoneCode", code); setZoneExpanded(false); };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (effectiveAction === "replace_photo" && !image) { setError(t.photoRequired); return; }
    if (action === "update" && source === "inventory" && !product) { setError(nt.selectProduct); return; }
    setSaving(true); setError("");
    try {
      const submitAction = action === "update" && zoneChanged ? (informationChanged ? "update_with_move" : "move") : effectiveAction;
      const payload: Record<string, unknown> = { ...values, ...(["use", "correct_remaining", "close", "reactivate"].includes(effectiveAction) ? { note: String(values.actionNote) } : null), ...(action === "update" ? { liquorSource: source, inventoryItemId: product?.id ?? null, zoneChanged } : null) };
      const form = new FormData(); form.set("action", submitAction); form.set("version", String(item.version)); form.set("payload", JSON.stringify(payload));
      if (image && (effectiveAction === "replace_photo" || effectiveAction === "reactivate")) { form.set("image", image.detail); form.set("thumbnail", image.thumbnail); }
      const response = await fetch(`/api/bar/keepings/${item.id}/actions`, { method: "POST", body: form });
      if (await handleBarApiUnauthorized(response)) return;
      const result = await response.json();
      if (response.status === 409 && result.code === "VERSION_CONFLICT") { setError(t.conflict); setSaving(false); return; }
      if (!response.ok) throw new Error(actionErrorMessage(result.code, lang, t.error));
      await onSaved(); onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : t.error); setSaving(false); }
  }

  const title = action === "update" ? t.edit : action === "use" ? t.use : action === "replace_photo" ? dt.photoChange : action === "reactivate" ? t.reactivate : effectiveAction === "correct_remaining" ? t.correct : t.close;
  const kind: "bottom" | "full" = action === "use" || action === "update" || action === "replace_photo" || action === "reactivate" ? "full" : "bottom";
  return <form onSubmit={save}><BarSheet kind={kind} compact={action === "use" || action === "replace_photo"} title={title} closeLabel={t.cancel} saving={saving || imageBusy} onClose={onClose} returnFocusRef={returnFocusRef} footer={<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}><button type="button" disabled={saving || imageBusy} onClick={onClose} style={secondaryButtonStyle}>{t.cancel}</button><button disabled={saving || imageBusy} style={effectiveAction === "close" ? dangerButtonStyle : primaryButtonStyle}>{saving ? t.saving : t.save}</button></div>}>
    {action === "use" ? <BarSegmentedControl label={t.use} value={processAction} disabled={saving} onChange={next => { setProcessAction(next); setError(""); }} options={[{ value: "use", label: dt.liquorUse }, { value: "correct_remaining", label: t.correct }, { value: "close", label: dt.keepingClose }]} /> : null}
    {action === "update" ? <><Input label={t.customerName} value={String(values.customerName)} set={v => set("customerName", v)} /><Input label={nt.customerContact} value={String(values.customerContact)} set={v => set("customerContact", v)} maxLength={120} /><Input label={nt.customerFeature} value={String(values.customerIdentifier)} set={v => set("customerIdentifier", v)} /><BarSegmentedControl label={nt.liquorSource} value={source} onChange={next => { setSource(next); setProduct(null); set("liquorName", ""); }} options={[{ value: "inventory", label: nt.soldProduct }, { value: "external", label: nt.outsideBottle }]} />{source === "inventory" ? <KeepingProductAutocomplete lang={lang} initialValue={item.liquorSource === "inventory" ? item.liquorName : ""} onSelect={(selected, name) => { setProduct(selected); set("liquorName", name); }} /> : <Input label={t.liquorName} value={String(values.liquorName)} set={v => set("liquorName", v)} />}<Input type="date" label={t.storedAt} value={String(values.storedAt)} set={v => set("storedAt", v)} /><StorageHelp lang={lang} /><Input area label={t.note} value={String(values.note)} set={v => set("note", v)} />{item.status === "active" ? <><button type="button" aria-expanded={zoneExpanded} aria-controls={zonePanelId} onClick={() => setZoneExpanded(value => !value)} style={zoneToggleStyle}><span>{dt.zoneChange}</span><span style={{minWidth:0,display:"flex",alignItems:"center",gap:8}}><strong style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{zoneChanged ? `${item.zoneCode} → ${String(values.zoneCode)}` : `${dt.currentZone} ${item.zoneCode}`}</strong><span aria-hidden style={{transform:zoneExpanded?"rotate(180deg)":"none",transition:"transform .15s"}}>⌄</span></span></button>{zoneExpanded ? <div id={zonePanelId}><KeepingZonePicker value={String(values.zoneCode)} onChange={selectUpdateZone} lang={lang} disabled={saving} hideLabel /></div> : null}</> : null}</> : null}
    {effectiveAction === "use" ? <><p style={helpStyle}>{dt.useHelp}</p><KeepingRegistrationPercentSelector label={t.remaining} directInputLabel={nt.directPercent} value={String(values.remainingPercent)} onChange={v => { set("remainingPercent", v); if (Number(v) === 0) set("finish", true); }} /><Input type="datetime-local" label={t.usedAt} value={String(values.usedAt)} set={v => set("usedAt", v)} /><Input area label={t.note} value={String(values.actionNote)} set={v => set("actionNote", v)} />{Number(values.remainingPercent) === 0 ? <label style={{ fontSize: 12 }}><input type="checkbox" checked={Boolean(values.finish)} onChange={e => set("finish", e.target.checked)} /> {t.finishTogether}</label> : null}</> : null}
    {effectiveAction === "correct_remaining" ? <><p style={helpStyle}>{dt.correctionHelp}</p><KeepingRegistrationPercentSelector label={t.remaining} directInputLabel={nt.directPercent} value={String(values.remainingPercent)} onChange={v => set("remainingPercent", v)} /><Input area label={t.note} value={String(values.actionNote)} set={v => set("actionNote", v)} /></> : null}
    {effectiveAction === "close" ? <><BarField label={t.closeReason} required>{({ id }) => <select id={id} value={String(values.closeReason)} onChange={e => set("closeReason", e.target.value)} style={keepingInputStyle}><option value="finished">{t.finished}</option><option value="returned">{t.returned}</option><option value="discarded">{t.discarded}</option><option value="expired">{t.expiredReason}</option><option value="other">{t.other}</option></select>}</BarField><Input type="datetime-local" label={t.closedAt} value={String(values.closedAt)} set={v => set("closedAt", v)} /><Input area label={t.note} value={String(values.actionNote)} set={v => set("actionNote", v)} /></> : null}
    {effectiveAction === "replace_photo" ? <>{item.imageUrl ? <img src={item.imageUrl} alt={dt.photoView} style={{display:"block",width:"100%",maxHeight:"46dvh",objectFit:"contain",borderRadius:12,background:"#f3f4f6"}} /> : null}<KeepingImageInput lang={lang} required onBusyChange={setImageBusy} onChange={setImage} /></> : null}
    {effectiveAction === "reactivate" ? <div style={reactivateContentStyle}><BarSection title={nt.storageSection} icon="📦" first><div style={reactivateZonePercentStyle}><KeepingZonePicker value={String(values.zoneCode)} onChange={v => set("zoneCode", v)} lang={lang} disabled={saving} /><KeepingRegistrationPercentSelector label={t.remaining} directInputLabel={nt.directPercent} value={String(values.remainingPercent)} onChange={v => set("remainingPercent", v)} disabled={saving} /></div><Input type="date" label={t.storedAt} required disabled={saving} value={String(values.storedAt)} set={v => set("storedAt", v)} /><StorageHelp lang={lang} /><Input area label={t.note} disabled={saving} placeholder={lang === "vi" ? "Nhập ghi chú nếu cần." : "필요한 경우 비고를 입력해 주세요."} value={String(values.actionNote)} set={v => set("actionNote", v)} /></BarSection><BarSection title={t.photo} icon="📷"><KeepingImageInput lang={lang} currentUrl={item.imageUrl} hideLabel disabled={saving} onBusyChange={setImageBusy} onChange={setImage} /></BarSection></div> : null}
    {error ? <p role="alert" style={{ margin: 0, padding: "9px 10px", borderRadius: 9, background: "#fef2f2", color: "#b91c1c", fontSize: 12 }}>{error}</p> : null}
  </BarSheet></form>;
}

const helpStyle: React.CSSProperties = { margin: 0, color: "#6b7280", fontSize: 11, lineHeight: 1.45 };
const reactivateContentStyle: React.CSSProperties = { width: "100%", maxWidth: 480, margin: "0 auto", minWidth: 0 };
const reactivateZonePercentStyle: React.CSSProperties = { minWidth: 0, display: "grid", gap: 22 };
const zoneToggleStyle: React.CSSProperties = { width: "100%", minWidth: 0, minHeight: 44, boxSizing: "border-box", padding: "0 12px", border: 0, borderRadius: 10, background: "#111827", color: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 12, fontWeight: 800, textAlign: "left", cursor: "pointer" };
function Input({ label, value, set, type = "text", area = false, required = false, disabled = false, maxLength, placeholder }: { label: string; value: string; set: (value: string) => void; type?: string; area?: boolean; required?: boolean; disabled?: boolean; maxLength?: number; placeholder?: string }) { return <BarField label={label} required={required}>{({ id, describedBy }) => area ? <textarea id={id} aria-describedby={describedBy} required={required} disabled={disabled} maxLength={maxLength} placeholder={placeholder} value={value} onChange={e => set(e.target.value)} style={{ ...keepingInputStyle, minHeight: 78, padding: "10px 12px", resize:"vertical", fontFamily: "inherit" }} /> : <input id={id} aria-describedby={describedBy} required={required} disabled={disabled} type={type} maxLength={maxLength} placeholder={placeholder} value={value} onChange={e => set(e.target.value)} style={keepingInputStyle} />}</BarField>; }
function StorageHelp({ lang }: { lang: "ko" | "vi" }) { return <p style={{ margin: 0, color: "#6b7280", fontSize: 11 }}>{lang === "vi" ? "Thời hạn lưu giữ là 3 tháng kể từ ngày bắt đầu." : "보관기간은 보관 시작일로부터 3개월입니다."}</p>; }
function localDateTime(date: Date) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date); const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ""; return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`; }
function actionErrorMessage(code: unknown, lang: "ko" | "vi", fallback: string) {
  const messages: Record<string, [string, string]> = {
    REACTIVATE_STORED_AT: ["보관 시작일을 확인해 주세요.", "Vui lòng kiểm tra ngày bắt đầu lưu giữ."],
    REACTIVATE_ZONE_CODE: ["보관 구역을 선택해 주세요.", "Vui lòng chọn khu vực lưu giữ."],
    REACTIVATE_REMAINING_PERCENT: ["현재 잔량을 확인해 주세요.", "Vui lòng kiểm tra lượng còn lại."],
    REACTIVATE_FILES: ["사진을 처리하지 못했습니다. 다시 선택해 주세요.", "Không thể xử lý ảnh. Vui lòng chọn lại."],
    REACTIVATE_VERSION: ["최신 키핑 정보를 다시 확인해 주세요.", "Vui lòng tải lại thông tin giữ rượu mới nhất."],
    REACTIVATE_ACTION: ["올바르지 않은 작업입니다.", "Thao tác không hợp lệ."],
    REACTIVATE_PAYLOAD: ["입력 정보를 다시 확인해 주세요.", "Vui lòng kiểm tra lại thông tin đã nhập."],
    REACTIVATE_NOTE: ["비고를 확인해 주세요.", "Vui lòng kiểm tra ghi chú."],
  };
  const pair = typeof code === "string" ? messages[code] : undefined;
  return pair ? pair[lang === "vi" ? 1 : 0] : fallback;
}
