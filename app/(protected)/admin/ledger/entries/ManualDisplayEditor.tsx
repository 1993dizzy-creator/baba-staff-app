"use client";

import { type ReactNode, useState } from "react";
import {
  BarField,
  keepingInputStyle,
  primaryButtonStyle,
} from "@/components/bar/keeping/KeepingUi";
import { formatLedgerAmountInput, sanitizeLedgerAmountInput } from "@/lib/ledger/manual-entry-amount";
import styles from "./entries.module.css";

type ManualDisplayDraft = { title: string; amount: string; memo: string; reason: string };

export function LedgerEditShell({ lang, title, saving, disabled, error, onSave, onCancel, children }: {
  lang: "ko" | "vi";
  title: string;
  saving: boolean;
  disabled: boolean;
  error: string;
  onSave: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const vi = lang === "vi";
  return <div className={styles.candidateEditor}>
    <div className={styles.editorTitle}>
      <h3>✏️ {title}</h3>
      <button type="button" disabled={saving} onClick={onCancel}>{vi ? "Hủy" : "취소"}</button>
    </div>
    {children}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <button type="button" disabled={saving || disabled} onClick={onSave} style={{ ...primaryButtonStyle, width: "100%" }}>
      {saving ? (vi ? "Đang lưu…" : "저장 중…") : (vi ? "Lưu sửa đổi" : "수정 저장")}
    </button>
  </div>;
}

export default function ManualDisplayEditor({
  lang,
  transactionId,
  originalTitle,
  originalMemo,
  originalAmount,
  amountEditable = false,
  closed,
  onSavingChange,
  onConfirmedEdited,
  onClose,
}: {
  lang: "ko" | "vi";
  transactionId: number;
  originalTitle: string;
  originalMemo: string;
  originalAmount?: number;
  amountEditable?: boolean;
  closed: boolean;
  onSavingChange: (saving: boolean) => void;
  onConfirmedEdited: (transactionId: number) => Promise<void>;
  onClose: () => void;
}) {
  const vi = lang === "vi";
  const [draft, setDraft] = useState<ManualDisplayDraft>({
    title: originalTitle,
    amount: String(originalAmount ?? ""),
    memo: originalMemo,
    reason: "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveManualDisplay() {
    if (saving || closed) return;
    const title = draft.title.trim();
    const memo = draft.memo.trim();
    const reason = draft.reason.trim();
    const amount = Number(draft.amount);
    if (!title) {
      setError(vi ? "Vui lòng nhập tiêu đề hiển thị." : "표시 제목을 입력해주세요.");
      return;
    }
    if (!reason) {
      setError(vi ? "Vui lòng nhập lý do chỉnh sửa." : "수정 사유를 입력해주세요.");
      return;
    }
    if (amountEditable && (!/^[0-9]+$/.test(draft.amount) || !Number.isSafeInteger(amount) || amount <= 0)) {
      setError(vi ? "Vui lòng nhập số tiền nguyên dương." : "금액은 양수 정수로 입력해주세요.");
      return;
    }
    if (title === originalTitle.trim() && memo === originalMemo.trim() &&
        (!amountEditable || amount === originalAmount)) {
      setError(vi ? "Không có nội dung nào thay đổi." : "변경된 내용이 없습니다.");
      return;
    }
    setError("");
    setSaving(true);
    onSavingChange(true);
    try {
      const response = await fetch("/api/admin/ledger/transactions/" + transactionId +
        (amountEditable ? "/manual-edit" : "/display"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(amountEditable ? { title, amount, memo, reason } : { title, memo, reason }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code ?? "MANUAL_DISPLAY_EDIT_FAILED");
      onClose();
      await onConfirmedEdited(transactionId);
    } catch (cause) {
      setError((vi ? "Không thể sửa giao dịch." : "거래를 수정하지 못했습니다.") + " " + (cause as Error).message);
    } finally {
      setSaving(false);
      onSavingChange(false);
    }
  }

  return (
    <LedgerEditShell lang={lang} title={vi ? "Sửa giao dịch thủ công" : "수동 거래 수정"}
      saving={saving} disabled={closed} error={error} onSave={() => void saveManualDisplay()} onCancel={onClose}>
      <BarField label={vi ? "Tiêu đề hiển thị" : "표시 제목"} required compact>
        {({ id }) => <input id={id} required maxLength={160} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} style={keepingInputStyle} />}
      </BarField>
      {amountEditable ? <BarField label={vi ? "Số tiền" : "금액"} required compact>
        {({ id }) => <input id={id} required inputMode="numeric" value={formatLedgerAmountInput(draft.amount)} onChange={event => setDraft({ ...draft, amount: sanitizeLedgerAmountInput(event.target.value) })} style={keepingInputStyle} />}
      </BarField> : null}
      <BarField label={vi ? "Ghi chú" : "메모"} compact>
        {({ id }) => <textarea id={id} maxLength={2000} rows={3} value={draft.memo} onChange={event => setDraft({ ...draft, memo: event.target.value })} style={keepingInputStyle} />}
      </BarField>
      <BarField label={vi ? "Lý do chỉnh sửa" : "수정 사유"} required compact>
        {({ id }) => <input id={id} required maxLength={500} value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} style={keepingInputStyle} />}
      </BarField>
    </LedgerEditShell>
  );
}

