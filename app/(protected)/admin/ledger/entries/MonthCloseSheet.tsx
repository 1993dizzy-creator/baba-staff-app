"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { BarSheet, primaryButtonStyle, secondaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import styles from "./entries.module.css";

type Issue = { code: string; count?: number; amount?: number };
type Preflight = { canClose: boolean; blockers: Issue[]; warnings: Issue[]; preflightHash: string };
type Check = { month?: string; state: "open" | "closed" | "reopened"; preflight?: Preflight };

const issueNames: Record<string, [string, string]> = {
  PAYMENT_VERIFICATION_UNRESOLVED: ["결제 미확인 입고", "Hàng nhập chưa xác minh thanh toán"],
  PAYMENT_VERIFICATION_LATER_PAID: ["월말 결제 미확인 입고", "Hàng nhập chưa xác minh thanh toán cuối tháng"],
  PAYABLE_OUTSTANDING: ["미납금", "Công nợ chưa thanh toán"],
  BALANCE_ADJUSTMENT: ["잔액 조정 기록", "Điều chỉnh số dư"],
  RESERVE_SHORTFALL: ["임대료 준비금 미충족", "Chưa đủ quỹ dự phòng tiền thuê"],
  EARLIER_MONTH_REOPENED: ["이전 월의 재검토가 진행 중", "Tháng trước đang được kiểm tra lại"],
  CURRENT_MONTH: ["이번 달은 아직 마감할 수 없음", "Chưa thể chốt tháng hiện tại"],
  FUTURE_MONTH: ["미래 월은 마감할 수 없음", "Chưa thể chốt tháng tương lai"],
  ALREADY_CLOSED: ["이미 마감된 장부", "Sổ đã được chốt"],
  PENDING_CANDIDATES: ["처리 대기 중인 장부 항목", "Khoản mục đang chờ xử lý"],
  PAYROLL_NOT_COMPLETED: ["급여 지급 미완료", "Chưa hoàn tất trả lương"],
  RECURRING_NOT_SYNCED: ["반복 지출 미반영", "Chi phí định kỳ chưa được ghi nhận"],
  CANDIDATE_LINK_BROKEN: ["확정 항목의 장부 연결 오류", "Khoản đã xác nhận chưa liên kết với sổ"],
  TRANSFER_UNBALANCED: ["계좌 이체 금액 불일치", "Chuyển khoản chưa cân đối"],
  REQUIRED_MOVEMENT_MISSING: ["거래의 자금 이동 기록 누락", "Thiếu dòng tiền của giao dịch"],
  PAYABLE_OVERALLOCATED: ["미납금 지급액 초과", "Phân bổ thanh toán vượt công nợ"],
  CARD_OVERALLOCATED: ["카드 정산액 초과", "Phân bổ đối soát thẻ vượt mức"],
  CARD_UNMATCHED: ["미확인 카드 정산", "Đối soát thẻ chưa khớp"],
  DUPLICATE_ACTIVE_SOURCE: ["중복된 장부 원본", "Nguồn ghi sổ bị trùng"],
  CONFIRMED_SOURCE_DRIFT: ["확정 원본 변경 미처리", "Thay đổi nguồn đã xác nhận chưa xử lý"],
};

function issueName(issue: Issue, vi: boolean) {
  return issueNames[issue.code]?.[vi ? 1 : 0] ?? (vi ? "Mục cần kiểm tra thêm" : "추가 점검 항목");
}

function issueValue(issue: Issue, vi: boolean) {
  if (issue.code.startsWith("PAYMENT_VERIFICATION_") && typeof issue.count === "number" && typeof issue.amount === "number")
    return `${issue.count}${vi ? " mục" : "건"} · ${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(issue.amount)} ₫`;
  if (typeof issue.amount === "number") return `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(issue.amount)} ₫`;
  if (typeof issue.count === "number") return `${issue.count}${vi ? " mục" : "건"}`;
  return vi ? "Cần kiểm tra" : "확인 필요";
}

export default function MonthCloseSheet({ month, revision, vi, onClose, onClosed, returnFocusRef }: {
  month: string;
  revision: number | null;
  vi: boolean;
  onClose: () => void;
  onClosed: () => Promise<void>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [check, setCheck] = useState<Check | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const monthNumber = Number(month.slice(5, 7));
  const reclose = revision !== null;

  const refresh = useCallback(async () => {
    setLoading(true);
    setCheck(null);
    try {
      const response = await fetch(`/api/admin/ledger/month-close?month=${month}`, { cache: "no-store" });
      const body = await response.json() as Check;
      if (!response.ok || body.month !== month || (body.state !== "open" && body.state !== "reopened")) throw new Error("LOAD_FAILED");
      setCheck(body);
    } catch {
      setError(vi ? "Không thể kiểm tra sổ. Vui lòng thử lại." : "장부를 점검하지 못했습니다. 다시 시도해주세요.");
    } finally {
      setLoading(false);
    }
  }, [month, vi]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function closeMonth() {
    const preflight = check?.preflight;
    if (busy || !preflight?.canClose || preflight.blockers?.length || !preflight.preflightHash) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/ledger/month-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close", month, expectedPreflightHash: preflight.preflightHash }),
      });
      const body = await response.json() as { code?: string };
      if (!response.ok) {
        if (body.code === "LEDGER_CLOSE_PREFLIGHT_STALE" || body.code === "PREFLIGHT_STALE" || body.code === "MONTH_CLOSE_BLOCKED") {
          setError(vi ? "Sổ đã thay đổi sau khi kiểm tra. Vui lòng xem lại." : "점검 이후 장부 내용이 변경되었습니다. 다시 확인해주세요.");
          await refresh();
          return;
        }
        throw new Error("CLOSE_FAILED");
      }
      await onClosed();
    } catch {
      setError(vi ? "Không thể chốt sổ. Vui lòng thử lại." : "장부를 마감하지 못했습니다. 다시 시도해주세요.");
    } finally {
      setBusy(false);
    }
  }

  const preflight = check?.preflight;
  const blockers = preflight?.blockers ?? [];
  const warnings = preflight?.warnings ?? [];
  const blocked = Boolean(preflight && (blockers.length > 0 || preflight.canClose !== true));
  return <BarSheet kind="bottom" topAligned comfortableTop
    title={vi ? `${reclose ? "Chốt lại" : "Chốt"} sổ tháng ${monthNumber}` : `${monthNumber}월 ${reclose ? "재마감" : "월마감"}`}
    closeLabel={vi ? "Đóng" : "닫기"} saving={busy} onClose={onClose} returnFocusRef={returnFocusRef}
    footer={<div className={styles.reopenFooter}>
      <button type="button" disabled={loading || busy || blocked || !preflight?.preflightHash} onClick={() => void closeMonth()}
        style={{ ...primaryButtonStyle, width: "100%" }}>
        {busy ? (vi ? "Đang chốt…" : "마감 중…") : vi ? "Hoàn tất chốt sổ" : "마감 완료"}
      </button>
      <button type="button" disabled={busy} onClick={onClose} style={{ ...secondaryButtonStyle, width: "100%" }}>
        {vi ? "Hủy" : "취소"}
      </button>
    </div>}>
    {loading ? <p className={styles.reopenHelp}>{vi ? "Đang kiểm tra sổ…" : "장부를 점검 중입니다…"}</p> : null}
    {check ? <div className={styles.closeSheetBody}>
      <section className={styles.closeCheckCard} aria-label={vi ? "Kiểm tra trước khi chốt" : "마감 점검"}>
        <h3 className={styles.closeCheckHeading}>{vi ? "Kiểm tra trước khi chốt" : "마감 점검"}</h3>
        <div className={styles.closeCheckRows}>
          <div className={`${styles.closeCheckRow} ${blocked ? styles.closeCheckRowBlocked : ""}`}>
            <span>{vi ? "Vấn đề chặn chốt sổ" : "마감 차단 문제"}</span>
            <strong className={blocked ? "" : styles.closeCheckClear}>{blockers.length ? `${blockers.length}${vi ? " mục" : "건"}` : blocked ? (vi ? "Cần kiểm tra" : "확인 필요") : (vi ? "Không có" : "없음")}</strong>
          </div>
          {blockers.map((issue, index) => <div className={`${styles.closeCheckRow} ${styles.closeCheckRowBlocked}`} key={`blocker-${index}`}>
            <span>{issueName(issue, vi)}</span><strong>{issueValue(issue, vi)}</strong>
          </div>)}
          {warnings.map((issue, index) => <div className={styles.closeCheckRow} key={`warning-${index}`}>
            <span>{issueName(issue, vi)}</span><strong>{issueValue(issue, vi)}</strong>
          </div>)}
        </div>
      </section>
      <div className={styles.closeNoticeCard}>
        {reclose ? <p>{vi ? `Bản chốt lần ${revision} được lưu trong lịch sử.` : `${revision}차 마감본은 이력으로 보존됩니다.`}</p> : null}
        <p>{vi ? "Sau khi chốt, việc sửa sổ sẽ bị hạn chế." : "마감 후에는 장부 수정이 제한됩니다."}</p>
      </div>
    </div> : null}
    {error ? <p role="alert" className={styles.closeBlocker}>{error}</p> : null}
    {!loading && !check ? <button type="button" className={styles.monthCloseAction} onClick={() => void refresh()}>{vi ? "Kiểm tra lại" : "다시 점검"}</button> : null}
  </BarSheet>;
}
