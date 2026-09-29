"use client";

import { useState } from "react";
import {
  BarField,
  keepingInputStyle,
  primaryButtonStyle,
} from "@/components/bar/keeping/KeepingUi";
import styles from "./entries.module.css";

type ManualDisplayDraft = { title: string; memo: string; reason: string };

export default function ManualDisplayEditor({
  lang,
  transactionId,
  originalTitle,
  originalMemo,
  closed,
  onSavingChange,
  onConfirmedEdited,
  onClose,
}: {
  lang: "ko" | "vi";
  transactionId: number;
  originalTitle: string;
  originalMemo: string;
  closed: boolean;
  onSavingChange: (saving: boolean) => void;
  onConfirmedEdited: (transactionId: number) => Promise<void>;
  onClose: () => void;
}) {
  const vi = lang === "vi";
  const [draft, setDraft] = useState<ManualDisplayDraft>({
    title: originalTitle,
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
    if (!title) {
      setError(vi ? "Vui lòng nhập tiêu đề hiển thị." : "표시 제목을 입력해주세요.");
      return;
    }
    if (!reason) {
      setError(vi ? "Vui lòng nhập lý do chỉnh sửa." : "수정 사유를 입력해주세요.");
      return;
    }
    if (title === originalTitle.trim() && memo === originalMemo.trim()) {
      setError(vi ? "Không có nội dung nào thay đổi." : "변경된 내용이 없습니다.");
      return;
    }
    setError("");
    setSaving(true);
    onSavingChange(true);
    try {
      const response = await fetch("/api/admin/ledger/transactions/" + transactionId + "/display", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, memo, reason }),
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
    <div className={styles.candidateEditor}>
      <h3>{vi ? "Sửa tiêu đề và ghi chú giao dịch thủ công" : "수동 거래 제목·메모 수정"}</h3>
      <BarField label={vi ? "Tiêu đề hiển thị" : "표시 제목"} required compact>
        {({ id }) => <input id={id} required maxLength={160} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} style={keepingInputStyle} />}
      </BarField>
      <BarField label={vi ? "Ghi chú" : "메모"} compact>
        {({ id }) => <textarea id={id} maxLength={2000} rows={3} value={draft.memo} onChange={event => setDraft({ ...draft, memo: event.target.value })} style={keepingInputStyle} />}
      </BarField>
      <BarField label={vi ? "Lý do chỉnh sửa" : "수정 사유"} required compact>
        {({ id }) => <input id={id} required maxLength={500} value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} style={keepingInputStyle} />}
      </BarField>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <button type="button" disabled={saving || closed} onClick={() => void saveManualDisplay()} style={{ ...primaryButtonStyle, width: "100%" }}>
        {vi ? "Lưu sửa đổi" : "수정 저장"}
      </button>
    </div>
  );
}

