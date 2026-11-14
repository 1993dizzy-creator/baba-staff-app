"use client";
// /admin/users 복리후생 설정 모달 전용 표시 부품(식대·개근 보너스·보험·TNCN 공통, 장기근무 레벨 모달은 모양만 재사용).
// 저장·검증·조회 로직은 각 설정 카드(레벨은 직원 상세)가 그대로 갖고, 여기서는 모양만 맞춘다. 급여설정 화면은 쓰지 않는다.
import { type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** 현재 적용 상태(급여 계산·스위치와 같은 pick 규칙의 적용 버전)와 예약된 다음 버전. */
export type BenefitModalStatus = {
  /** 적용 중인 버전이 없으면 null(미설정) */
  applied: { on: boolean; since?: string | null; detail?: string } | null;
  scheduled: { on: boolean; from: string } | null;
};

/** 상단 상태 줄: 현재 적용 상태(적용 시작일/월)와 예약을 따로 보여 준다(예약을 현재 상태로 표시하지 않음). */
export function BenefitStatusLine({ status, vi, onLabel, offLabel, unsetLabel }: {
  status: BenefitModalStatus; vi: boolean; onLabel: string; offLabel: string; unsetLabel: string;
}) {
  const { applied, scheduled } = status;
  const nowLabel = applied ? (applied.on ? onLabel : offLabel) : unsetLabel;
  return (
    <div style={m.status} role="group" aria-label={vi ? "Trạng thái hiện tại" : "현재 상태"}>
      <div style={m.statusRow}>
        <span style={m.statusCaption}>{vi ? "Hiện tại" : "현재"}</span>
        <b style={applied?.on ? m.badgeOn : m.badgeOff}>{nowLabel}</b>
        {applied?.since ? <span style={m.statusSince}>{vi ? `từ ${applied.since}` : `${applied.since}부터`}</span> : null}
      </div>
      {applied?.detail ? <span style={m.statusDetail}>{applied.detail}</span> : null}
      {scheduled ? (
        <span style={m.schedule}>
          {vi
            ? `Đã đặt lịch: ${scheduled.on ? onLabel : offLabel} từ ${scheduled.from}`
            : `예약: ${scheduled.from}부터 ${scheduled.on ? onLabel : offLabel}`}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 적용/미적용 2분할 선택(라디오 그룹). onDisabled: 기존 정책상 적용을 고를 수 없을 때(예: 근태 미사용).
 * 선택은 색만이 아니라 흰 표면·테두리·그림자와 ✓ 표시로 구분한다(진한 회색 홈 위의 흰 버튼).
 */
export function BenefitChoice({ label, value, onChange, onLabel, offLabel, onDisabled = false }: {
  label: string; value: boolean; onChange: (value: boolean) => void; onLabel: string; offLabel: string; onDisabled?: boolean;
}) {
  const option = (optionValue: boolean, text: string, disabled: boolean) => (
    <button
      type="button"
      role="radio"
      aria-checked={value === optionValue}
      disabled={disabled}
      onClick={() => onChange(optionValue)}
      style={{ ...m.choice, ...(value === optionValue ? m.choiceSelected : null), ...(disabled ? m.choiceDisabled : null) }}
    >
      {value === optionValue ? <span aria-hidden="true" style={m.choiceCheck}>✓</span> : null}
      {text}
    </button>
  );
  return (
    <div role="radiogroup" aria-label={label} style={m.choiceGroup}>
      {option(true, onLabel, onDisabled && !value)}
      {option(false, offLabel, false)}
    </div>
  );
}

/**
 * 모달 하단의 취소·저장 한 세트. 시트 footer(target)에 그린다. 저장은 form 속성으로 카드의 폼을 제출하므로
 * 브라우저 필수 입력 검증·카드의 submit 검증이 그대로 적용된다. canSave가 false면 저장을 막고 hint로 이유를 알린다.
 */
export function BenefitModalActions({ target, formId, vi, saving, canSave, hint, saveLabel, onCancel }: {
  target: HTMLElement | null | undefined; formId: string; vi: boolean; saving: boolean; canSave: boolean;
  hint: string | null; saveLabel?: string; onCancel: () => void;
}) {
  if (!target) return null;
  return createPortal(
    <>
      {hint ? <p role="status" style={m.hint}>{hint}</p> : null}
      <button type="button" style={m.cancel} disabled={saving} onClick={onCancel}>{vi ? "Hủy" : "취소"}</button>
      <button type="submit" form={formId} style={{ ...m.save, ...(!canSave || saving ? m.saveDisabled : null) }} disabled={!canSave || saving}>
        {saving ? (vi ? "Đang lưu…" : "저장 중…") : saveLabel ?? (vi ? "Lưu" : "저장")}
      </button>
    </>,
    target,
  );
}

/** 모달 폼 필드 한 줄(라벨 + 입력). */
export function BenefitField({ label, children }: { label: string; children: ReactNode }) {
  return <label style={m.field}><span>{label}</span>{children}</label>;
}

/** 모달 본문 공통 스타일(카드 테두리 없이 섹션 간격으로 구분). */
export const m = {
  body: { display: "grid", gap: 14, minWidth: 0 },
  status: { display: "grid", gap: 4, minWidth: 0, padding: "10px 12px", borderRadius: 12, background: "#f8fafc", fontSize: 12 },
  statusRow: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 8px", minWidth: 0 },
  statusCaption: { color: "#6b7280", fontWeight: 700 },
  statusSince: { color: "#374151", fontWeight: 700 },
  statusDetail: { color: "#374151", fontWeight: 700, overflowWrap: "anywhere" },
  badgeOn: { padding: "2px 8px", borderRadius: 999, background: "#dcfce7", color: "#166534", fontSize: 12, fontWeight: 900 },
  badgeOff: { padding: "2px 8px", borderRadius: 999, background: "#e5e7eb", color: "#374151", fontSize: 12, fontWeight: 900 },
  schedule: { color: "#92400e", fontWeight: 800, overflowWrap: "anywhere" },
  form: { display: "grid", gap: 12, minWidth: 0 },
  // 홈(진한 중립 회색 #CBD5E1)과 선택 버튼(흰 표면)의 대비로 모달 배경과 구분한다.
  choiceGroup: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 4, padding: 4, borderRadius: 12, background: "#cbd5e1", minWidth: 0 },
  choice: { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, minWidth: 0, minHeight: 44, padding: "6px 8px", boxSizing: "border-box", border: "1px solid transparent", borderRadius: 9, background: "transparent", color: "#475569", fontFamily: "inherit", fontSize: 14, fontWeight: 700, lineHeight: 1.25, textAlign: "center", cursor: "pointer", overflowWrap: "anywhere" },
  // border는 단축 속성으로만 바꾼다(borderColor 단독 지정은 선택 해제 때 React가 색을 지워 검은 테두리가 남는다).
  choiceSelected: { border: "1px solid #94a3b8", background: "#fff", color: "#0f172a", fontWeight: 900, boxShadow: "0 1px 3px rgba(15,23,42,.18)" },
  choiceCheck: { flexShrink: 0, fontSize: 13, fontWeight: 900 },
  choiceDisabled: { color: "#64748b", cursor: "not-allowed" },
  field: { display: "grid", gap: 5, minWidth: 0, fontSize: 13, fontWeight: 700, color: "#374151" },
  input: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 44, padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 10, background: "#fff", fontSize: 14 },
  textarea: { width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: 64, padding: "8px 10px", border: "1px solid #d1d5db", borderRadius: 10, fontSize: 14, resize: "vertical" },
  notice: { margin: 0, padding: "8px 10px", borderRadius: 10, background: "#fffbeb", color: "#92400e", fontSize: 12, lineHeight: 1.45 },
  error: { margin: 0, padding: "8px 10px", borderRadius: 10, background: "#fef2f2", color: "#b91c1c", fontSize: 12, lineHeight: 1.45 },
  muted: { margin: 0, color: "#6b7280", fontSize: 12, lineHeight: 1.45 },
  details: { minWidth: 0, fontSize: 12, color: "#374151" },
  // 기본 display(list-item)를 유지해 접기 화살표가 보이게 한다.
  summary: { minHeight: 32, padding: "6px 0", boxSizing: "border-box", fontWeight: 800, cursor: "pointer" },
  reference: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginTop: 6, padding: "8px 10px", borderRadius: 10, background: "#f8fafc", minWidth: 0 },
  referenceItem: { display: "grid", gap: 2, minWidth: 0, overflowWrap: "anywhere" },
  hint: { gridColumn: "1 / -1", margin: 0, color: "#6b7280", fontSize: 12, lineHeight: 1.4, textAlign: "center" },
  cancel: { minHeight: 44, padding: "8px 12px", border: "1px solid #d1d5db", borderRadius: 10, background: "#fff", color: "#111827", fontSize: 14, fontWeight: 800 },
  save: { minHeight: 44, padding: "8px 12px", border: 0, borderRadius: 10, background: "#111827", color: "#fff", fontSize: 14, fontWeight: 800 },
  saveDisabled: { background: "#9ca3af", cursor: "not-allowed" },
} satisfies Record<string, CSSProperties>;

/** 참고 정보의 한 항목. */
export function BenefitReferenceItem({ label, value }: { label: string; value: string }) {
  return <div style={m.referenceItem}><span style={{ color: "#6b7280" }}>{label}</span><b>{value}</b></div>;
}
