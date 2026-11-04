"use client";

import { useEffect, useRef, useState } from "react";
import { BarField, keepingInputStyle } from "@/components/bar/keeping/KeepingUi";
import { planCardDepositWithFees, type AutoCardFeeMonth } from "@/lib/ledger/card-fee-policy";
import { formatLedgerAmountInput, parseLedgerAmount, sanitizeLedgerAmountInput } from "@/lib/ledger/manual-entry-amount";
import { manualBusinessDate } from "@/lib/ledger/manual-transaction-form";
import styles from "./card-settlements.module.css";

// 카드 실제 입금 등록(장부 내역 추가 › 수입 › 카드입금). 일반 수입이 아니라 기존 카드정산 API
// (POST /api/admin/ledger/card-settlements → ledger_create_card_deposit_auto_allocate_v1)로만 저장한다.
// 미리보기는 RPC와 같은 FIFO·수수료 계약이며, RPC가 저장 시 잠금 상태에서 다시 계산·검증한다.

type Lang = "ko" | "vi";
export type CardDepositSale = { id: number; business_date: string; outstandingGrossAmount: number };
export type CardDepositSources = { month: string; sales: CardDepositSale[]; autoFeeMonths: AutoCardFeeMonth[] };

export const cardDepositText = {
  ko: {
    depositDate: "입금일시", depositAmount: "실제 입금액", memo: "메모", submitDeposit: "입금 등록", actualDeposit: "실제 입금", saleDate: "매출일",
    autoPreview: "자동 정산 미리보기", autoPreviewHint: "실제 입금액을 입력하면 오래된 미정산 카드매출부터 자동 정산합니다.",
    availableOutstanding: "정산 가능 미정산", thisSettlement: "이번 정산", totalSettlement: "총 정산",
    insufficientOutstanding: "미정산 카드매출 잔액이 실제 입금액보다 부족합니다.", invalidAmount: "실제 입금액을 확인해주세요.",
    noEligibleSales: "입금일 이전의 미정산 카드매출이 없습니다.", reviewRequired: "카드 정산 데이터를 확인해주세요.",
    dataInvalid: "카드 정산 데이터를 확인해주세요. 입금은 저장되지 않았습니다.", createFailed: "등록 실패", readFailed: "카드 정산 정보를 불러오지 못했습니다.",
    loading: "카드 정산 정보를 불러오는 중…",
    created: (count: number) => count > 0 ? `카드 입금을 등록하고 카드매출 ${count}건을 자동 정산했습니다.` : "카드 입금을 등록했습니다.",
    businessDate: (date: string) => `03:00 이전이라 ${date} 영업일 입금으로 정산합니다.`,
  },
  vi: {
    depositDate: "Thời điểm tiền về", depositAmount: "Số tiền thực nhận", memo: "Ghi chú", submitDeposit: "Ghi nhận", actualDeposit: "Tiền thực nhận", saleDate: "Ngày bán",
    autoPreview: "Xem trước quyết toán tự động", autoPreviewHint: "Nhập số tiền thực nhận để tự động quyết toán doanh thu thẻ cũ nhất trước.",
    availableOutstanding: "Có thể quyết toán", thisSettlement: "Lần này", totalSettlement: "Tổng quyết toán",
    insufficientOutstanding: "Số dư doanh thu thẻ chưa quyết toán nhỏ hơn số tiền thực nhận.", invalidAmount: "Hãy kiểm tra số tiền thực nhận.",
    noEligibleSales: "Không có doanh thu thẻ chưa quyết toán trước ngày tiền về.", reviewRequired: "Cần kiểm tra dữ liệu quyết toán thẻ.",
    dataInvalid: "Dữ liệu quyết toán thẻ cần được kiểm tra. Khoản tiền về chưa được lưu.", createFailed: "Ghi nhận thất bại", readFailed: "Không thể tải thông tin quyết toán thẻ.",
    loading: "Đang tải thông tin quyết toán thẻ…",
    created: (count: number) => count > 0 ? `Đã ghi nhận tiền thẻ và tự động quyết toán ${count} doanh thu thẻ.` : "Đã ghi nhận tiền thẻ.",
    businessDate: (date: string) => `Trước 03:00 nên quyết toán theo ngày kinh doanh ${date}.`,
  },
} as const;

const money = (n: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n)} ₫`;
const shortDate = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;
const localNow = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);

// 입금일시(베트남 현지) → RPC와 같은 영업일(03:00 이전은 전날).
export function cardDepositBusinessDate(depositAt: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(depositAt) ? manualBusinessDate(depositAt.slice(0, 10), depositAt.slice(11, 16)) : depositAt.slice(0, 10);
}

export function cardDepositErrorMessage(code: string, lang: Lang) {
  const t = cardDepositText[lang];
  if (["INSUFFICIENT_UNSETTLED_CARD_SALES", "INSUFFICIENT_CARD_PENDING"].includes(code)) return t.insufficientOutstanding;
  if (["CARD_FEE_REVIEW_REQUIRED", "CARD_DATA_INVALID"].includes(code)) return t.dataInvalid;
  return code;
}

// 미정산 카드매출과 자동 수수료 대상월(마감월)은 선택월과 무관한 전체 상태다. 열릴 때 1회 조회한다.
export function useCardDepositSources(month: string, enabled: boolean) {
  const [sources, setSources] = useState<CardDepositSources | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const [settlementResponse, feeResponse] = await Promise.all([
          fetch(`/api/admin/ledger/card-settlements?month=${month}`, { cache: "no-store", signal: controller.signal }),
          fetch(`/api/admin/ledger/card-fees?month=${month}`, { cache: "no-store", signal: controller.signal }),
        ]);
        const [settlement, fee] = await Promise.all([settlementResponse.json(), feeResponse.json()]);
        if (!settlementResponse.ok || !feeResponse.ok) throw new Error(settlement.code ?? fee.code ?? "CARD_SETTLEMENTS_LOAD_FAILED");
        if (controller.signal.aborted) return;
        setSources({ month, sales: settlement.sales ?? [], autoFeeMonths: fee.autoFeeMonths ?? [] });
        setError(null);
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      }
    })();
    return () => controller.abort();
  }, [month, enabled]);
  return { sources: sources?.month === month ? sources : null, error };
}

export function useCardDepositDraft({ lang, sources, saving, setSaving, onCreated }: {
  lang: Lang; sources: CardDepositSources | null; saving: boolean; setSaving: (value: boolean) => void;
  onCreated: (allocationCount: number) => Promise<void> | void;
}) {
  const t = cardDepositText[lang];
  const [depositAt, setDepositAt] = useState(localNow), [amount, setAmount] = useState(""), [memo, setMemo] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const businessDate = cardDepositBusinessDate(depositAt);
  // Same FIFO contract as ledger_create_card_deposit_auto_allocate_v1; the RPC re-plans under lock on save.
  const plan = planCardDepositWithFees(sources?.sales ?? [], parseLedgerAmount(amount) ?? 0, businessDate, sources?.autoFeeMonths ?? []);
  const canSubmit = !!sources && !saving && plan.error === null;
  async function submit() {
    const depositAmount = parseLedgerAmount(amount);
    if (inFlight.current || !sources || saving || depositAmount === null || plan.error) return;
    inFlight.current = true; setSaving(true); setError("");
    try {
      const response = await fetch("/api/admin/ledger/card-settlements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ depositAt: `${depositAt}:00+07:00`, amount: depositAmount, memo }) });
      const body = await response.json();
      if (!response.ok) throw new Error(cardDepositErrorMessage(String(body.code), lang));
      await onCreated(Array.isArray(body.result?.allocations) ? body.result.allocations.length : 0);
    } catch (cause) {
      setError(`${t.createFailed}: ${(cause as Error).message}`);
    } finally {
      inFlight.current = false; setSaving(false);
    }
  }
  return { depositAt, setDepositAt, amount, setAmount, memo, setMemo, businessDate, plan, canSubmit, error, submit };
}

export type CardDepositDraft = ReturnType<typeof useCardDepositDraft>;

// 입력 필드 + 자동 정산 미리보기. form 요소는 감싸는 쪽이 제공한다.
export function CardDepositFields({ lang, draft, sources, sourcesError, disabled }: {
  lang: Lang; draft: CardDepositDraft; sources: CardDepositSources | null; sourcesError: string | null; disabled: boolean;
}) {
  const t = cardDepositText[lang], { plan } = draft;
  const saleDateLabel = (date: string) => `${t.saleDate} ${shortDate(date)}`;
  return <div className={styles.formGrid} data-card-deposit-form>
    <BarField label={`📅 ${t.depositDate}`} required compact>{({ id }) => <input id={id} data-card-deposit-field="deposit-at" required type="datetime-local" disabled={disabled} value={draft.depositAt} onChange={e => draft.setDepositAt(e.target.value)} style={keepingInputStyle} />}</BarField>
    {draft.businessDate !== draft.depositAt.slice(0, 10) ? <p className={styles.hint} data-card-deposit-field="business-date-note">{t.businessDate(draft.businessDate)}</p> : null}
    <BarField label={`💵 ${t.depositAmount}`} required compact>{({ id }) => <input id={id} data-card-deposit-field="amount" required inputMode="numeric" autoComplete="off" disabled={disabled} value={formatLedgerAmountInput(draft.amount)} onChange={e => draft.setAmount(sanitizeLedgerAmountInput(e.target.value))} style={keepingInputStyle} />}</BarField>
    <section className={styles.preview} aria-live="polite" aria-label={t.autoPreview}>
      <strong>💡 {t.autoPreview}</strong>
      {sourcesError ? <p role="alert" className={styles.validation}>{t.readFailed} {sourcesError}</p>
      : !sources ? <p>{t.loading}</p>
      : !draft.amount ? <>
        <p>{t.autoPreviewHint}</p>
        <p>{t.availableOutstanding} {money(plan.availableOutstanding)}</p>
      </> : plan.error === "exceeds_outstanding" ? <p role="alert" className={styles.validation}>{t.insufficientOutstanding} ({t.availableOutstanding} {money(plan.availableOutstanding)})</p>
      : plan.error === "nothing_outstanding" ? <p role="alert" className={styles.validation}>{t.noEligibleSales}</p>
      : plan.error === "review_required" ? <p role="alert" className={styles.validation}>{t.reviewRequired}</p>
      : plan.error ? <p role="alert" className={styles.validation}>{t.invalidAmount}</p>
      : <>
        <ol className={styles.previewRows}>{plan.rows.map(row => <li key={row.transactionId}>
          <div><time dateTime={row.businessDate}>{saleDateLabel(row.businessDate)}</time><span>{t.thisSettlement} <strong>{money(row.allocatedAmount)}</strong></span></div>
          <div className={styles.previewBalance}>{money(row.outstandingBefore)} → {money(row.outstandingAfter)}</div>
        </li>)}</ol>
        <p className={styles.previewTotal}>{t.totalSettlement} <strong>{money(plan.totalAllocated)}</strong> = {t.actualDeposit}</p>
      </>}
    </section>
    <BarField label={`📝 ${t.memo}`} compact>{({ id }) => <input id={id} data-card-deposit-field="memo" disabled={disabled} value={draft.memo} onChange={e => draft.setMemo(e.target.value)} style={keepingInputStyle} />}</BarField>
    {draft.error ? <p role="alert" className={styles.validation}>{draft.error}</p> : null}
  </div>;
}
