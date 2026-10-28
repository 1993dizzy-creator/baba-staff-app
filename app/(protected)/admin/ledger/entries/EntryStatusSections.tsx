"use client";

import type { ReactNode } from "react";
import type { InventoryProjectionIssue } from "@/components/ledger/InventoryProjectionResolution";
import { purchaseCaseDisplay } from "@/lib/inventory/purchase-case-display";
import type { LedgerEntry } from "@/lib/ledger/entries";
import { inventoryPurchaseStatusSummary } from "@/lib/ledger/inventory-purchase-status";
import styles from "./entries.module.css";

type Lang = "ko" | "vi";
const money = (amount: number) =>
  `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(amount))} ₫`;

function StatusPanel({ testId, state, headline, facts, checks, steps, lang }: {
  testId: string; state: "ok" | "open" | "review"; headline: string;
  facts: [string, string, boolean?][]; checks: ReactNode[]; steps: ReactNode[]; lang: Lang;
}) {
  const vi = lang === "vi";
  return (
    <section className={`${styles.statusPanel} ${styles[`statusPanel_${state}`]}`} data-testid={testId}>
      <h3 className={styles.statusPanelTitle}>{vi ? "Trạng thái hiện tại" : "현재 상태"}</h3>
      <p className={styles.statusHeadline}>{headline}</p>
      <dl className={styles.statusFacts}>
        {facts.map(([label, value, strong]) => <div key={label}><dt>{label}</dt><dd>{strong ? <strong>{value}</strong> : value}</dd></div>)}
      </dl>
      <h3 className={styles.statusPanelTitle}>{vi ? "Cần kiểm tra" : "확인할 내용"}</h3>
      {checks.length
        ? <ul className={styles.statusList} data-testid={`${testId}-checks`}>{checks.map((check, index) => <li key={index}>{check}</li>)}</ul>
        : <p className={styles.statusNone} data-testid={`${testId}-checks`}>{vi ? "Không có vấn đề cần kiểm tra." : "확인할 문제가 없습니다."}</p>}
      <h3 className={styles.statusPanelTitle}>{vi ? "Cách xử lý" : "해결 방법"}</h3>
      <ul className={styles.statusList} data-testid={`${testId}-steps`}>{steps.map((step, index) => <li key={index}>{step}</li>)}</ul>
    </section>
  );
}

// 장부 반영 전 / 결제 미확인 / 원입고 차이: short title, the key amounts, one line of what to do.
function PurchaseNotice({ testId, kind, title, facts, children }: {
  testId: string; kind: "pending" | "verificationPending" | "issue"; title: string; facts?: [string, string][]; children: ReactNode;
}) {
  return (
    <section className={styles.purchaseNotice} data-testid={testId} data-status-kind={kind}>
      <p className={styles.purchaseNoticeTitle}><span className={styles.purchaseNoticeIcon} aria-hidden="true">!</span>{title}</p>
      {facts ? (
        <dl className={styles.statusFacts}>
          {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      ) : null}
      {children}
    </section>
  );
}

// Issues from the ledger's "장부 확인 필요" list that belong to this row's receipts.
export function inventoryEntryIssues(entry: LedgerEntry, issues: readonly InventoryProjectionIssue[]) {
  const logIds = new Set(entry.items.map(item => item.inventoryLogId).filter((id): id is number => id != null));
  return issues.filter(issue => logIds.has(issue.inventoryLogId) ||
    (issue.rootInventoryLogId != null && logIds.has(issue.rootInventoryLogId)) ||
    (issue.relatedLogIds ?? []).some(id => logIds.has(id)));
}

// Inventory purchase detail, first screen. A paid purchase (immediate, or 미납 paid in
// full) shows nothing; open 미납 shows only the way to 미납금 현황; 장부 반영 전 and
// 결제 미확인 show one compact notice; a receipt's 원입고 issue is always shown.
// Settlement internals, audit rows and raw JSON stay in the advanced section.
export function InventoryPurchaseStatus({ entry, issues, lang, onOpenPayableParty, onShowPayables, onShowIssue }: {
  entry: LedgerEntry; issues: readonly InventoryProjectionIssue[]; lang: Lang;
  onOpenPayableParty?: () => void; onShowPayables?: () => void; onShowIssue: (inventoryLogId: number) => void;
}) {
  const vi = lang === "vi";
  if (entry.drilldown !== "inventory") return null;
  const matched = inventoryEntryIssues(entry, issues);
  const issueNotice = matched.length ? (
    <PurchaseNotice testId="inventory-status-issues" kind="issue" title={vi ? "Khác với phiếu nhập gốc" : "원입고와 차이"}>
      <ul className={styles.purchaseNoticeList}>
        {matched.map(issue => {
          const display = purchaseCaseDisplay(issue, vi);
          const name = vi ? issue.itemNameVi || issue.itemName : issue.itemName;
          return (
            <li key={issue.inventoryLogId} data-testid={`inventory-status-issue-${issue.inventoryLogId}`}>
              <strong>{name} · {display.reason}</strong>
              {display.changes.map(change => <span key={change.kind} className={styles.statusDiff}>{change.text}</span>)}
            </li>
          );
        })}
      </ul>
      <p className={styles.purchaseNoticeAction}>
        {vi ? "Đối chiếu phiếu nhập gốc rồi chỉnh sổ." : "원입고와 대조해 장부를 정정하세요."}{" "}
        <button type="button" className={styles.statusLink} onClick={() => onShowIssue(matched[0].inventoryLogId)}>
          {vi ? "Đi tới mục cần kiểm tra" : "확인 필요 항목으로 이동"} ›
        </button>
      </p>
    </PurchaseNotice>
  ) : null;

  if (entry.status === "pending") {
    return <>
      <PurchaseNotice testId="inventory-status" kind="pending" title={vi ? "Chưa ghi sổ" : "장부 반영 전"}
        facts={[[vi ? "Số tiền mua" : "매입금액", money(entry.amount)], [vi ? "Thực trả" : "실제 지급액", vi ? "Chưa ghi sổ" : "미반영"]]}>
        <p className={styles.purchaseNoticeAction}>{vi ? "Chọn cách thanh toán ở [Sửa] của mặt hàng bên dưới." : "아래 품목의 [수정]에서 결제 방식을 선택하세요."}</p>
      </PurchaseNotice>
      {issueNotice}
    </>;
  }

  const { payable, original, paid, remaining, verificationPending } = inventoryPurchaseStatusSummary(entry);
  if (verificationPending) {
    return <>
      <PurchaseNotice testId="inventory-status" kind="verificationPending" title={vi ? "Chưa xác minh thanh toán" : "결제 미확인"}
        facts={[[vi ? "Số tiền mua" : "매입금액", money(original)], [vi ? "Thực trả" : "실제 지급액", money(paid)], [vi ? "Còn phải trả" : "미지급 잔액", money(remaining)]]}>
        <p className={styles.purchaseNoticeAction}>
          {vi ? "Nếu đã trả, ghi ở “Công nợ” › “Khác · Chưa xác minh” bằng [Thanh toán riêng]." : "지급했다면 [미납금 현황] › [기타 · 결제 미확인]에서 [개별 결제]로 기록하세요."}
          {onShowPayables ? <>{" "}<button type="button" className={styles.statusLink} onClick={onShowPayables}>{vi ? "Đi tới tình hình công nợ" : "미납금 현황으로 이동"} ›</button></> : null}
        </p>
      </PurchaseNotice>
      {issueNotice}
    </>;
  }

  const openPayables = payable && remaining > 0 ? onOpenPayableParty ?? onShowPayables : undefined;
  if (!openPayables && !issueNotice) return null;
  return <>
    {openPayables ? (
      <button type="button" className={styles.purchasePayableLink} data-testid="inventory-status-payable" onClick={openPayables}>
        {vi ? "Mở tình hình công nợ" : "미납금 현황 열기"} ›
      </button>
    ) : null}
    {issueNotice}
  </>;
}

// A recurring plan's monthly recognition with no money movement, and the
// actual advance payment it allocates from: P&L and cash are read separately.
export function PrepaidExpenseStatus({ entry, lang }: { entry: LedgerEntry; lang: Lang }) {
  const vi = lang === "vi";
  const allocation = entry.prepaidAllocation;
  if (allocation) {
    const rent = entry.systemDisplay?.kind === "rent";
    const basis = [allocation.planName, allocation.monthlyAmount != null ? `${vi ? "mỗi tháng" : "월"} ${money(allocation.monthlyAmount)}` : null,
      allocation.effectiveFrom ? (vi ? `từ ${allocation.effectiveFrom}` : `${allocation.effectiveFrom}부터`) : null].filter(Boolean).join(" · ");
    return <StatusPanel testId="prepaid-allocation-status" state="ok" lang={lang}
      headline={vi ? "Phân bổ chi phí trả trước · không cần thanh toán thêm" : "선납 비용배분 · 추가 결제 불필요"}
      facts={[
        [vi ? "Chi phí ghi nhận tháng này (lãi lỗ)" : "이번 달 손익 인식", money(entry.amount), true],
        [vi ? "Thực trả" : "실제 지급", money(0)],
        [vi ? "Còn phải trả" : "미지급 잔액", money(0)],
      ]}
      checks={[
        rent
          ? (vi ? "Tiền thuê năm đã được trả trước; đây là phần chi phí của tháng này." : "연간 임대료는 이미 선납했고, 이 기록은 그중 이번 달 몫을 비용으로 배분한 것입니다.")
          : (vi ? "Khoản này đã được trả trước; đây là phần chi phí của tháng này." : "미리 지급한 금액 중 이번 달 몫을 비용으로 배분한 기록입니다."),
        vi ? `Lãi lỗ tháng: tính ${money(entry.amount)} vào chi phí.` : `월 손익: 비용 ${money(entry.amount)}에 포함됩니다.`,
        vi ? "Tiền mặt: không có tiền chi trong ngày. Không cộng vào tổng chi theo ngày hay “Thực chi”; số dư tài khoản và công nợ không đổi."
          : "현금: 이날 나간 돈이 없습니다. 날짜별 지출 합계와 실제 지출에 넣지 않으며, 계좌 잔액과 미지급금도 바뀌지 않습니다.",
        ...(basis ? [`${vi ? "Căn cứ" : "기준"}: ${basis}`] : []),
      ]}
      steps={[vi ? "Không cần xử lý. Khoản chi thực tế được ghi ở giao dịch thanh toán trả trước." : "조치할 필요가 없습니다. 실제 현금 지급은 선납 지급 거래에 따로 기록되어 있습니다."]} />;
  }
  if (!entry.prepaidPayment) return null;
  return <StatusPanel testId="prepaid-payment-status" state="ok" lang={lang}
    headline={vi ? "Đã thanh toán trả trước" : "선납 지급 완료"}
    facts={[
      [vi ? "Thực trả" : "실제 지급", money(entry.amount), true],
      [vi ? "Tài khoản chi" : "지급 계정", entry.accountName ?? (vi ? "Chưa rõ" : "미지정")],
      [vi ? "Chi phí ghi nhận tháng này" : "이번 달 손익 반영", money(0)],
    ]}
    checks={[vi
      ? "Đây là tiền thực chi. Chi phí không ghi một lần mà được phân bổ vào lãi lỗ từng tháng."
      : "실제 현금이 나간 기록입니다. 손익에는 한 번에 넣지 않고 매월 비용배분으로 나누어 반영합니다."]}
    steps={[vi ? "Không cần xử lý." : "조치할 필요가 없습니다."]} />;
}
