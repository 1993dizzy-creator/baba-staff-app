"use client";

import { useEffect, useRef, useState } from "react";
import { BarField, BarSegmentedControl, dangerButtonStyle, keepingInputStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { formatLedgerAmountInput, sanitizeLedgerAmountInput } from "@/lib/ledger/manual-entry-amount";
import { isManualExpenseCategory, isManualIncomeCategory, manualExpenseCategoryLabel, manualExpenseCategorySort, manualIncomeCategorySort } from "@/lib/ledger/manual-entry-policy";
import { manualBusinessDate, manualFormChanges, manualFormFromSource, manualFormMessage, type ManualEditSource, type ManualFormState, type ManualFormType } from "@/lib/ledger/manual-transaction-form";
import { LedgerEditShell } from "./ManualDisplayEditor";
import PartnerSelect from "./PartnerSelect";
import styles from "./entries.module.css";

type Lang = "ko" | "vi";
export type ManualFormAccount = { id: number; display_name: string; is_active: boolean };
export type ManualFormCategory = { id: number; name: string; kind: "income" | "expense" };
export type ManualFormPartner = { id: number; name: string; partnerType: string | null; isActive: boolean; emoji: string; ledgerPartyId: number; manualExpenseCategoryId: number | null };

// The same category lists as the "장부 내역 추가" sheet.
export function manualCategoryOptions<T extends ManualFormCategory>(type: string, categories: readonly T[]) {
  return type === "expense" ? categories.filter(isManualExpenseCategory).sort(manualExpenseCategorySort)
    : type === "income" ? categories.filter(isManualIncomeCategory).sort(manualIncomeCategorySort) : [];
}

export function AccountField({ lang, label, fieldName, value, setValue, accounts }: {
  lang: Lang; label: string; fieldName?: string; value: string; setValue: (value: string) => void; accounts: readonly ManualFormAccount[];
}) {
  return (
    <BarField label={label} required compact>
      {({ id }) => (
        <select id={id} data-manual-field={fieldName} required value={value} onChange={(event) => setValue(event.target.value)} style={keepingInputStyle}>
          <option value="">{lang === "vi" ? "Chọn" : "선택"}</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.display_name}</option>)}
        </select>
      )}
    </BarField>
  );
}

// Income / expense / transfer fields shared by creation and full edit.
export function ManualTransactionFields({ lang, value, onChange, partners, categories, accounts, showTitle = false }: {
  lang: Lang; value: ManualFormState; onChange: (next: ManualFormState) => void;
  partners: readonly ManualFormPartner[]; categories: readonly ManualFormCategory[]; accounts: readonly ManualFormAccount[]; showTitle?: boolean;
}) {
  const vi = lang === "vi";
  const set = (patch: Partial<ManualFormState>) => onChange({ ...value, ...patch });
  const activeAccounts = accounts.filter(account => account.is_active);
  const options = manualCategoryOptions(value.type, categories);
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(value.date) && /^\d{2}:\d{2}$/.test(value.time) ? manualBusinessDate(value.date, value.time) : null;
  return <>
    <BarSegmentedControl scrollable label={vi ? "Loại giao dịch" : "거래 유형"} value={value.type}
      onChange={(next: ManualFormType) => set({ type: next, categoryId: "", partnerId: next === "expense" ? value.partnerId : "",
        fromAccountId: next === "income" ? "" : value.fromAccountId, toAccountId: next === "expense" ? "" : value.toAccountId })}
      options={[
        { value: "expense", label: `💸 ${vi ? "Chi" : "지출"}` },
        { value: "income", label: `💰 ${vi ? "Thu" : "수입"}` },
        { value: "transfer", label: `🔄 ${vi ? "Chuyển tiền" : "이체"}` },
      ]} />
    <div className={styles.manualGrid}>
      <div className={styles.manualRow}>
        <BarField label={`📅 ${vi ? "Ngày" : "거래일"}`} required compact>
          {({ id }) => <input id={id} data-manual-field="date" type="date" required value={value.date} onChange={event => set({ date: event.target.value })} style={keepingInputStyle} />}
        </BarField>
        <BarField label={`🕒 ${vi ? "Giờ" : "시각"}`} required compact>
          {({ id }) => <input id={id} data-manual-field="time" type="time" required value={value.time} onChange={event => set({ time: event.target.value })} style={keepingInputStyle} />}
        </BarField>
      </div>
      {businessDate && businessDate !== value.date ? <p className={styles.manualNotice} data-manual-field="business-date-note">
        {vi ? `Trước 03:00 tính vào ngày kinh doanh ${businessDate}.` : `03:00 이전이라 ${businessDate} 영업일로 기록됩니다.`}</p> : null}
      <div className={`${styles.manualRow} ${value.type !== "expense" ? styles.manualSingle : ""}`}>
        <BarField label={`💵 ${vi ? "Số tiền" : "금액"}`} required compact>
          {({ id }) => <input id={id} data-manual-field="amount" required inputMode="numeric" autoComplete="off" value={formatLedgerAmountInput(value.amount)}
            onChange={event => set({ amount: sanitizeLedgerAmountInput(event.target.value) })} style={keepingInputStyle} />}
        </BarField>
        {value.type === "expense" ? <BarField label={`🤝 ${vi ? "Đối tác (không bắt buộc)" : "거래처 (선택)"}`} compact>
          {({ id }) => <PartnerSelect id={id} manual partners={partners} lang={lang} value={value.partnerId} onChange={partnerId => {
            const partner = partners.find(row => String(row.id) === partnerId);
            set({ partnerId, ...(partner?.manualExpenseCategoryId ? { categoryId: String(partner.manualExpenseCategoryId) } : {}) });
          }} />}
        </BarField> : null}
      </div>
      <div className={styles.manualRow}>
        {value.type !== "transfer" ? <BarField label={`🏷️ ${vi ? "Danh mục" : "카테고리"}`} required compact>
          {({ id }) => <select id={id} data-manual-field={`${value.type}-category`} required value={value.categoryId} onChange={event => set({ categoryId: event.target.value })} style={keepingInputStyle}>
            <option value="">{vi ? "Chọn" : "선택"}</option>
            {options.map(row => <option key={row.id} value={row.id}>{value.type === "expense" ? manualExpenseCategoryLabel(row.name, lang) : row.name}</option>)}
          </select>}
        </BarField> : null}
        {value.type !== "income" ? <AccountField lang={lang} label={`🏦 ${vi ? "Tài khoản chi" : "출금 계정"}`} fieldName={`${value.type}-from-account`} value={value.fromAccountId} setValue={fromAccountId => set({ fromAccountId })} accounts={activeAccounts} /> : null}
        {value.type !== "expense" ? <AccountField lang={lang} label={`🏦 ${vi ? "Tài khoản nhận" : "입금 계정"}`} fieldName={`${value.type}-to-account`} value={value.toAccountId} setValue={toAccountId => set({ toAccountId })} accounts={activeAccounts} /> : null}
      </div>
      {showTitle ? <BarField label={`📝 ${vi ? "Tiêu đề hiển thị" : "표시 제목"}`} compact>
        {({ id }) => <input id={id} data-manual-field="title" maxLength={160} value={value.title} onChange={event => set({ title: event.target.value })} style={keepingInputStyle} />}
      </BarField> : null}
      <BarField label={`🗒️ ${vi ? "Ghi chú" : "메모"}`} compact>
        {({ id }) => <textarea id={id} data-manual-field="memo" maxLength={2000} rows={2} value={value.memo} onChange={event => set({ memo: event.target.value })} style={keepingInputStyle} />}
      </BarField>
    </div>
  </>;
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.code ?? "REQUEST_FAILED");
  return result;
}

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}

// Full edit: the current values are the defaults; only changed fields are sent, against the
// version shown (expectedUpdatedAt).
export function ManualTransactionEditor({ lang, transactionId, source, partners, categories, accounts, closed, onSavingChange, onSaved, onClose }: {
  lang: Lang; transactionId: number; source: ManualEditSource; partners: readonly ManualFormPartner[]; categories: readonly ManualFormCategory[];
  accounts: readonly ManualFormAccount[]; closed: boolean; onSavingChange: (saving: boolean) => void;
  onSaved: (transactionId: number) => Promise<void>; onClose: () => void;
}) {
  const vi = lang === "vi";
  const [initial] = useState(() => manualFormFromSource(source, partners));
  const [draft, setDraft] = useState(initial);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const mounted = useMounted();
  async function save() {
    if (inFlight.current || saving || closed) return;
    const result = manualFormChanges(source, initial, draft, partners);
    if (result.error) { setError(manualFormMessage(result.error, lang)); return; }
    if (!reason.trim()) { setError(manualFormMessage("reason", lang)); return; }
    inFlight.current = true; setSaving(true); onSavingChange(true); setError("");
    try {
      await postJson(`/api/admin/ledger/transactions/${transactionId}/manual-update`, { expectedUpdatedAt: source.updatedAt, changes: result.changes, reason: reason.trim() });
      if (!mounted.current) return;
      await onSaved(transactionId);
      if (mounted.current) onClose();
    } catch (cause) {
      if (!mounted.current) return;
      const code = (cause as Error).message;
      setError(code === "LEDGER_REFRESH_FAILED"
        ? (vi ? "Đã lưu nhưng không thể tải lại màn hình. Vui lòng tải lại trang." : "저장했지만 화면을 갱신하지 못했습니다. 새로고침해 주세요.")
        : manualFormMessage(code, lang));
    } finally {
      inFlight.current = false;
      if (mounted.current) { setSaving(false); onSavingChange(false); }
    }
  }
  return <LedgerEditShell lang={lang} title={vi ? "Sửa giao dịch thủ công" : "수동 거래 수정"} saving={saving} disabled={closed} error={error} onSave={() => void save()} onCancel={onClose}>
    <ManualTransactionFields lang={lang} value={draft} onChange={setDraft} partners={partners} categories={categories} accounts={accounts} showTitle />
    <BarField label={vi ? "Lý do chỉnh sửa" : "수정 사유"} required compact>
      {({ id }) => <input id={id} data-manual-field="reason" required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} style={keepingInputStyle} />}
    </BarField>
  </LedgerEditShell>;
}

// "삭제" = audited cancel: reason first, then an explicit confirmation. The original row,
// its movements and the audit history stay; the ledger list and every total exclude it.
export function ManualTransactionDelete({ lang, transactionId, source, closed, onSavingChange, onDeleted, onClose }: {
  lang: Lang; transactionId: number; source: ManualEditSource; closed: boolean; onSavingChange: (saving: boolean) => void;
  onDeleted: () => Promise<void>; onClose: () => void;
}) {
  const vi = lang === "vi";
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const mounted = useMounted();
  async function remove() {
    if (inFlight.current || saving || closed) return;
    if (!reason.trim()) { setError(manualFormMessage("reason", lang)); return; }
    const amount = new Intl.NumberFormat("vi-VN").format(source.amount);
    if (!window.confirm(vi ? `Xóa giao dịch ${amount} ₫?\nGiao dịch gốc và lịch sử vẫn được lưu; số dư và tổng sẽ không còn tính khoản này.`
      : `${amount} ₫ 거래를 삭제할까요?\n원본과 이력은 보존되고, 잔액과 합계에서만 빠집니다.`)) return;
    inFlight.current = true; setSaving(true); onSavingChange(true); setError("");
    try {
      await postJson(`/api/admin/ledger/transactions/${transactionId}/cancel`, { expectedUpdatedAt: source.updatedAt, reason: reason.trim() });
      if (!mounted.current) return;
      await onDeleted();
    } catch (cause) {
      if (mounted.current) setError(manualFormMessage((cause as Error).message, lang));
    } finally {
      inFlight.current = false;
      if (mounted.current) { setSaving(false); onSavingChange(false); }
    }
  }
  return <div className={styles.candidateEditor} data-manual-delete aria-busy={saving}>
    <div className={styles.editorTitle}><h3>🗑️ {vi ? "Xóa giao dịch" : "거래 삭제"}</h3>
      <button type="button" disabled={saving} onClick={onClose}>{vi ? "Hủy" : "취소"}</button></div>
    <p className={styles.manualNotice}>{vi ? "Giao dịch gốc, bản ghi tài khoản và lịch sử được giữ nguyên. Chỉ không còn tính vào thu, chi, chuyển tiền và số dư."
      : "원본 거래·계정 기록·이력은 그대로 보존되고, 수입·지출·이체와 계좌 잔액에서만 빠집니다."}</p>
    <BarField label={vi ? "Lý do xóa" : "삭제 사유"} required compact>
      {({ id }) => <input id={id} data-manual-field="delete-reason" required maxLength={500} disabled={saving} value={reason} onChange={event => setReason(event.target.value)} style={keepingInputStyle} />}
    </BarField>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <button type="button" disabled={saving || closed || !reason.trim()} onClick={() => void remove()} style={{ ...dangerButtonStyle, width: "100%" }}>
      {saving ? (vi ? "Đang xóa…" : "삭제 중…") : (vi ? "Xóa" : "삭제")}</button>
    <button type="button" disabled={saving} onClick={onClose} style={{ ...secondaryButtonStyle, width: "100%" }}>{vi ? "Đóng" : "닫기"}</button>
  </div>;
}
