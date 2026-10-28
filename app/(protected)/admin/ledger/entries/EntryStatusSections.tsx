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

// Issues from the ledger's "장부 확인 필요" list that belong to this row's receipts.
export function inventoryEntryIssues(entry: LedgerEntry, issues: readonly InventoryProjectionIssue[]) {
  const logIds = new Set(entry.items.map(item => item.inventoryLogId).filter((id): id is number => id != null));
  return issues.filter(issue => logIds.has(issue.inventoryLogId) ||
    (issue.rootInventoryLogId != null && logIds.has(issue.rootInventoryLogId)) ||
    (issue.relatedLogIds ?? []).some(id => logIds.has(id)));
}

// Inventory purchase detail, first screen: 현재 상태 → 확인할 내용 → 해결 방법.
// Settlement internals, audit rows and raw JSON stay in the advanced section.
export function InventoryPurchaseStatus({ entry, issues, lang, onOpenPayableParty, onShowPayables, onShowIssue }: {
  entry: LedgerEntry; issues: readonly InventoryProjectionIssue[]; lang: Lang;
  onOpenPayableParty?: () => void; onShowPayables?: () => void; onShowIssue: (inventoryLogId: number) => void;
}) {
  const vi = lang === "vi";
  if (entry.drilldown !== "inventory") return null;
  const matched = inventoryEntryIssues(entry, issues);
  const differenceChecks = matched.map(issue => {
    const display = purchaseCaseDisplay(issue, vi);
    const name = vi ? issue.itemNameVi || issue.itemName : issue.itemName;
    return (
      <span key={issue.inventoryLogId} data-testid={`inventory-status-issue-${issue.inventoryLogId}`}>
        <strong>{name} · {display.reason}</strong>
        {display.changes.map(change => <span key={change.kind} className={styles.statusDiff}>{change.text}</span>)}
        {display.explanation ? <span className={styles.statusDiff}>{display.explanation}</span> : null}
      </span>
    );
  });
  const issueStep = matched.length ? (
    <span>
      {vi ? "Đối chiếu với phiếu nhập gốc rồi chỉnh sổ trong mục “Cần kiểm tra sổ” phía trên danh sách." : "원입고와 대조한 뒤 목록 위 [장부 확인 필요]에서 장부를 정정하세요."}{" "}
      <button type="button" className={styles.statusLink} onClick={() => onShowIssue(matched[0].inventoryLogId)}>
        {vi ? "Đi tới mục cần kiểm tra" : "확인 필요 항목으로 이동"} ›
      </button>
    </span>
  ) : null;

  if (entry.status === "pending") {
    return <StatusPanel testId="inventory-status" state="review" lang={lang}
      headline={vi ? "Chưa ghi sổ · cần chọn cách thanh toán" : "장부 반영 전 · 결제 방식 선택 필요"}
      facts={[[vi ? "Số tiền mua" : "매입금액", money(entry.amount), true], [vi ? "Thực trả" : "실제 지급액", vi ? "Chưa ghi sổ" : "미반영"]]}
      checks={differenceChecks}
      steps={[vi ? "Bấm [Sửa] ở mặt hàng, chọn Thanh toán ngay / Ghi nhận công nợ / Chưa xác minh rồi ghi sổ." : "품목의 [수정]에서 즉시 결제·미지급 등록·결제 미확인 중 하나를 골라 반영하세요.", issueStep].filter(Boolean)} />;
  }

  const { payable, original, paid, remaining, adjustment, state, verificationPending } = inventoryPurchaseStatusSummary(entry);
  const party = entry.title.trim() || (vi ? "nhà cung cấp" : "거래처");
  const headline = !payable
    ? (vi ? `Đã thanh toán ngay · ${entry.accountName ?? "chưa rõ tài khoản"}` : `즉시 결제 완료 · ${entry.accountName ?? "계정 미지정"}`)
    : state === "paid" ? (vi ? "Đã thanh toán đủ" : "지급 완료")
    : state === "partial" ? (vi ? `Đã trả một phần · còn ${money(remaining)}` : `일부 지급 · ${money(remaining)} 남음`)
    : verificationPending ? (vi ? "Chưa xác minh thanh toán · chưa trả" : "결제 미확인 · 실제 지급 기록 없음")
    : (vi ? "Chưa thanh toán (công nợ)" : "미납 · 아직 지급하지 않았습니다");

  const checks: ReactNode[] = [];
  if (payable && remaining > 0) checks.push(vi
    ? `Còn ${money(remaining)} chưa thanh toán cho ${party}.`
    : `${party}에 ${money(remaining)}이 아직 지급되지 않았습니다.`);
  if (verificationPending) checks.push(vi
    ? "Giao dịch được ghi là “Chưa xác minh thanh toán”: chưa rõ đã trả thực tế hay chưa, và không tính vào công nợ cuối tháng."
    : "결제 미확인으로 반영된 거래입니다. 실제 지급 여부가 확인되지 않았고, 월말 미납 합계에는 포함되지 않습니다.");
  if (adjustment !== 0) checks.push(vi
    ? `Thực trả chênh ${money(Math.abs(adjustment))} so với số tiền mua; phần này đã được điều chỉnh không dùng tiền, không cần trả thêm.`
    : `실제 지급액이 매입금액과 ${money(Math.abs(adjustment))} 다릅니다. 이 차액은 비현금 조정으로 정산되어 추가 지급은 필요 없습니다.`);
  checks.push(...differenceChecks);

  const steps: ReactNode[] = [];
  if (verificationPending) {
    steps.push(<span key="verify">
      {vi
        ? "Nếu đã trả: mở “Tình hình công nợ” › “Khác · Chưa xác minh thanh toán”, chọn [Thanh toán riêng] cho mặt hàng này và ghi tài khoản chi, ngày thanh toán. Sau khi ghi, giao dịch đổi sang [Trả một phần] hoặc [Thanh toán]."
        : "이미 지급했다면 [미납금 현황] › [기타 · 결제 미확인]에서 이 품목의 [개별 결제]로 지급 계정과 지급일을 기록하세요. 기록하면 이 매입이 [일부결제] 또는 [결제]로 바뀝니다."}
      {onShowPayables ? <>{" "}<button type="button" className={styles.statusLink} onClick={onShowPayables}>{vi ? "Đi tới tình hình công nợ" : "미납금 현황으로 이동"} ›</button></> : null}
    </span>);
    steps.push(vi ? "Nếu chưa trả hoặc chưa rõ: đừng ghi. Khoản này vẫn ở mục chưa xác minh." : "지급하지 않았거나 확인되지 않았다면 기록하지 마세요. 결제 미확인으로 계속 남습니다.");
  } else if (payable && remaining > 0) {
    steps.push(<span key="pay">
      {vi
        ? "Nếu đã trả: ghi nhận thanh toán ở “Tình hình công nợ” của nhà cung cấp này. Sau khi ghi, giao dịch tự đổi sang [Trả một phần] hoặc [Thanh toán]."
        : "이미 지급했다면 [미납금 현황]에서 이 거래처를 열어 지급을 등록하세요. 등록하면 이 매입이 자동으로 [일부결제] 또는 [결제]로 바뀝니다."}
      {onOpenPayableParty ? <>{" "}<button type="button" className={styles.statusLink} onClick={onOpenPayableParty}>{vi ? "Mở công nợ của nhà cung cấp" : "이 거래처 미납금 열기"} ›</button></> : null}
    </span>);
    steps.push(vi ? "Nếu chưa trả: không cần làm gì thêm, khoản này vẫn nằm trong công nợ." : "아직 지급 전이라면 조치할 필요가 없습니다. 미납금으로 계속 관리됩니다.");
  }
  if (issueStep) steps.push(issueStep);
  if (!steps.length) steps.push(vi ? "Không cần xử lý thêm." : "추가 조치가 필요 없습니다.");

  return <StatusPanel testId="inventory-status" state={matched.length ? "review" : state === "paid" ? "ok" : "open"} lang={lang}
    headline={headline}
    facts={[
      [vi ? "Số tiền mua" : "매입금액", money(original)],
      [vi ? "Thực trả" : "실제 지급액", money(paid)],
      [vi ? "Còn phải trả" : "미지급 잔액", money(remaining), true],
    ]}
    checks={checks} steps={steps} />;
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
