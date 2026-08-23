"use client";

import { useState } from "react";
import { BarField, BarSection, BarSegmentedControl, BarSheet, keepingInputStyle, primaryButtonStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import type { PartnerSubtype } from "@/components/PartnerForm";
import { PARTNER_TYPES, type PartnerType } from "@/lib/partners/policy";
import { formatPartnerSubtypeName, partnerTypeLabels } from "@/lib/partners/text";

type Props = {
  lang: "ko" | "vi";
  open: boolean;
  partnerSubtypes: PartnerSubtype[];
  onClose: () => void;
  onReload: () => Promise<void>;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
};

const labels = {
  ko: { title: "중분류 관리", close: "닫기", groupLabel: "대분류", listLabel: "중분류 목록", add: "+ 중분류 추가", edit: "중분류 수정", nameKo: "한국어", nameVi: "Tiếng Việt", sortOrder: "정렬순서", status: "사용 여부", active: "사용 중", inactive: "사용 안 함", cancel: "취소", save: "저장", saving: "저장 중…", empty: "등록된 중분류가 없습니다.", nameRequired: "한국어 또는 베트남어 중 하나는 입력해야 합니다." },
  vi: { title: "Quản lý danh mục phụ", close: "Đóng", groupLabel: "Ngành / loại", listLabel: "Danh sách danh mục phụ", add: "+ Thêm danh mục phụ", edit: "Sửa danh mục phụ", nameKo: "Tiếng Hàn", nameVi: "Tiếng Việt", sortOrder: "Thứ tự", status: "Trạng thái", active: "Đang dùng", inactive: "Ngừng dùng", cancel: "Hủy", save: "Lưu", saving: "Đang lưu…", empty: "Chưa có danh mục phụ nào.", nameRequired: "Cần nhập ít nhất tiếng Hàn hoặc tiếng Việt." },
} as const;

// Reuses the shared BarSheet chrome (same pattern as the "+ 거래처 추가" dialog on this
// page) instead of a separate large management screen. No physical delete: deactivate is
// the only removal path, since a subtype may already be referenced by a Partner.
export default function PartnerSubtypeManager({ lang, open, partnerSubtypes, onClose, onReload, returnFocusRef }: Props) {
  const t = labels[lang];
  const [groupType, setGroupType] = useState<PartnerType>("alcohol");
  const [editing, setEditing] = useState<PartnerSubtype | "new" | null>(null);
  const [nameKo, setNameKo] = useState("");
  const [nameVi, setNameVi] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const rows = partnerSubtypes.filter(subtype => subtype.partnerType === groupType).sort((a, b) => a.sortOrder - b.sortOrder);

  function startCreate() {
    setEditing("new"); setNameKo(""); setNameVi(""); setSortOrder("0"); setIsActive(true); setError("");
  }
  function startEdit(subtype: PartnerSubtype) {
    setEditing(subtype); setNameKo(subtype.nameKo ?? ""); setNameVi(subtype.nameVi ?? ""); setSortOrder(String(subtype.sortOrder)); setIsActive(subtype.isActive); setError("");
  }

  async function save() {
    if (!nameKo.trim() && !nameVi.trim()) { setError(t.nameRequired); return; }
    setSaving(true); setError("");
    try {
      const isCreate = editing === "new";
      const url = isCreate ? "/api/admin/partners/subtypes" : `/api/admin/partners/subtypes/${(editing as PartnerSubtype).id}`;
      const body: Record<string, unknown> = { nameKo: nameKo.trim() || null, nameVi: nameVi.trim() || null, sortOrder: Number(sortOrder) || 0 };
      if (isCreate) body.partnerType = groupType; else body.isActive = isActive;
      const response = await fetch(url, { method: isCreate ? "POST" : "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { setError(result.code); return; }
      await onReload();
      setEditing(null);
    } finally { setSaving(false); }
  }

  if (!open) return null;
  return <BarSheet kind="full" title={t.title} closeLabel={t.close} saving={saving} onClose={onClose} returnFocusRef={returnFocusRef} footer={editing
    ? <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={{ ...secondaryButtonStyle, flex: 1 }} disabled={saving} onClick={() => setEditing(null)}>{t.cancel}</button>
        <button type="button" style={{ ...primaryButtonStyle, flex: 1 }} disabled={saving} onClick={() => void save()}>{saving ? t.saving : t.save}</button>
      </div>
    : <button type="button" style={{ ...primaryButtonStyle, width: "100%" }} onClick={startCreate}>{t.add}</button>}>
    <BarSection title={t.groupLabel} icon="📂" first>
      <select value={groupType} onChange={event => { setGroupType(event.target.value as PartnerType); setEditing(null); }} style={keepingInputStyle}>
        {PARTNER_TYPES.map(type => <option key={type} value={type}>{partnerTypeLabels[type][lang]}</option>)}
      </select>
    </BarSection>
    {editing ? <BarSection title={editing === "new" ? t.add : t.edit} icon="✏️">
      <BarField label={t.nameKo}>{({ id }) => <input id={id} maxLength={80} value={nameKo} onChange={event => setNameKo(event.target.value)} style={keepingInputStyle} />}</BarField>
      <BarField label={t.nameVi}>{({ id }) => <input id={id} maxLength={80} value={nameVi} onChange={event => setNameVi(event.target.value)} style={keepingInputStyle} />}</BarField>
      <BarField label={t.sortOrder}>{({ id }) => <input id={id} type="number" inputMode="numeric" value={sortOrder} onChange={event => setSortOrder(event.target.value)} style={keepingInputStyle} />}</BarField>
      {editing !== "new" ? <div style={{ display: "grid", gap: 5 }}>
        <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>{t.status}</span>
        <BarSegmentedControl label={t.status} value={isActive ? "active" : "inactive"} onChange={next => setIsActive(next === "active")} options={[{ value: "active", label: t.active }, { value: "inactive", label: t.inactive }]} />
      </div> : null}
      {error ? <p role="alert" style={{ margin: 0, color: "#b91c1c", fontSize: 12 }}>{error}</p> : null}
    </BarSection> : <BarSection title={t.listLabel} icon="📋">
      <div style={{ display: "grid", gap: 6 }}>
        {rows.map(subtype => <button key={subtype.id} type="button" onClick={() => startEdit(subtype)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 44, padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 10, background: subtype.isActive ? "#fff" : "#f9fafb", color: "#111827", textAlign: "left", cursor: "pointer" }}>
          <span>{formatPartnerSubtypeName(subtype, lang)}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: subtype.isActive ? "#166534" : "#9ca3af" }}>{subtype.isActive ? t.active : t.inactive}</span>
        </button>)}
        {rows.length === 0 ? <p style={{ margin: 0, padding: "12px 4px", color: "#6b7280", fontSize: 12 }}>{t.empty}</p> : null}
      </div>
    </BarSection>}
  </BarSheet>;
}
