"use client";
import { useRef, useState, type ReactNode } from "react";
import styles from "./card-settlements.module.css";

// Unified card fee view for a past month: two KPIs, one-line range warning, compact
// status, a 3-row reference table, then collapsed breakdown and POS review. Read-only:
// it never books, confirms or cancels; candidate receipts load only when opened.
type ScenarioKey = "min" | "target" | "max";
export type CardFeeEstimateView = {
  gross: number; confirmedFee: number; unconfirmedEstimate: number; currentEstimate: number; rate: number | null;
  rangeStatus: "no_sales" | "below" | "within" | "above";
  scenarios: { key: ScenarioKey; rate: number; expectedFee: number; difference: number }[];
  manualExpenses: { id: number; amount: number; memo: string | null }[];
  manualExpenseTotal: number; manualCoveredEstimate: number; unrecognizedEstimate: number; duplicateRisk: boolean; provisionalManualOnly: boolean;
};
export type CardFeeView = {
  month: string; monthClosed: boolean; autoStatus?: string; historicalConfirmedFee: number; monthEndFee: number; currentOutstanding: number;
  projectedTotalFee: number; finalConfirmedFee: number | null; remainingRate: number | null; confirmedRate: number | null;
  closure: { confirmed_at: string; finalization_business_date?: string | null } | null; estimate?: CardFeeEstimateView;
};
type Candidate = {
  receiptId: number; refNo: string | null; businessDate: string; cardAmount: number; receiptFinalAmount: number; distance: number;
  cardNames: string[]; paymentMethods: string[]; posStatus: "paid" | "canceled" | "refunded" | "unpaid";
  ledgerStatus: "reflected" | "excluded" | "day_mismatch" | "ledger_missing"; ledgerDayAmount: number | null; posDayCardAmount: number;
};
type Lookup = { loading: boolean; error: string; candidates: Candidate[] | null };
const text = {
  ko: {
    estimated: "추정 수수료", confirmedKpi: "확정 수수료", rate: "수수료율", reference: "참고",
    above: "참고 범위 초과", below: "참고 범위 미달", vsTarget: "목표 대비",
    official: "공식 확정", auto: "자동", manualConfirm: "수동",
    provisional: "잠정 비용 처리", protected: "자동 중복 확정 보호", notOfficial: "공식 확정 미완료",
    closed: "장부 마감", beforeClose: "월마감 전", nextDeposit: "다음 카드입금 때 자동 확정 대상", review: "확인 필요",
    duplicate: "수기 비용과 공식 확정이 겹칠 수 있습니다. 중복계상 여부를 확인하세요.",
    basis: "기준", expected: "예상 수수료(₫)", difference: "차액(₫)", min: "최소", target: "목표", max: "최대",
    differenceHint: "차액 = 현재 추정 − 기준 예상",
    details: "세부 내역 · 수기 전표", gross: "월 카드매출", confirmedTotal: "확정 수수료", historicalPart: "└ 기존 확정", monthEndPart: "└ 월말 확정",
    unconfirmed: "미확정 추정(미정산 잔액)", manual: "수기 비용 전표", manualCovered: "└ 추정액 중 수기 처리분", unrecognized: "└ 남은 미반영 추정액",
    reviewTitle: "POS 영수증 검토 후보", reviewHint: "선택한 차액과 카드결제액이 가까운 영수증입니다. 금액이 비슷하다는 것만으로 오류로 확정하지 않습니다.",
    pick: "기준 차액 선택", noDifference: "차액이 없어 조회할 후보가 없습니다.", loading: "불러오는 중…", failed: "조회 실패", empty: "카드결제 영수증이 없습니다.",
    candidate: "검토 후보", businessDate: "영업일", receiptTotal: "영수증 총액", gap: "차이",
    pos: "POS", ledger: "장부", paid: "결제완료", canceled: "취소", refunded: "환불", unpaid: "미결제",
    reflected: "반영", excluded: "제외 대상", day_mismatch: "일자 금액 불일치", ledger_missing: "장부 없음",
    dayCompare: "일 카드 POS {pos} · 장부 {ledger}", open: "POS 상세",
  },
  vi: {
    estimated: "Phí ước tính", confirmedKpi: "Phí đã xác nhận", rate: "Tỷ lệ phí", reference: "Tham chiếu",
    above: "Vượt khoảng tham chiếu", below: "Dưới khoảng tham chiếu", vsTarget: "So với mục tiêu",
    official: "Đã xác nhận chính thức", auto: "Tự động", manualConfirm: "Thủ công",
    provisional: "Đã ghi chi phí tạm tính", protected: "Chặn xác nhận tự động trùng", notOfficial: "Chưa xác nhận chính thức",
    closed: "Đã chốt sổ", beforeClose: "Chưa chốt sổ", nextDeposit: "Tự động xác nhận khi có tiền thẻ về", review: "Cần kiểm tra",
    duplicate: "Chi phí thủ công có thể trùng với xác nhận chính thức. Hãy kiểm tra ghi trùng.",
    basis: "Mức", expected: "Phí dự kiến (₫)", difference: "Chênh lệch (₫)", min: "Tối thiểu", target: "Mục tiêu", max: "Tối đa",
    differenceHint: "Chênh lệch = ước tính hiện tại − phí dự kiến",
    details: "Chi tiết · Bút toán thủ công", gross: "Doanh thu thẻ tháng", confirmedTotal: "Phí đã xác nhận", historicalPart: "└ Đã xác nhận trước", monthEndPart: "└ Xác nhận cuối tháng",
    unconfirmed: "Ước tính chưa xác nhận (còn chưa quyết toán)", manual: "Bút toán chi phí thủ công", manualCovered: "└ Phần ước tính đã ghi thủ công", unrecognized: "└ Ước tính còn chưa ghi",
    reviewTitle: "Hóa đơn POS cần xem xét", reviewHint: "Hóa đơn có số tiền thanh toán thẻ gần với chênh lệch đã chọn. Số tiền gần nhau không có nghĩa là chắc chắn có lỗi.",
    pick: "Chọn chênh lệch", noDifference: "Không có chênh lệch nên không có hóa đơn để tìm.", loading: "Đang tải…", failed: "Tải thất bại", empty: "Không có hóa đơn thanh toán thẻ.",
    candidate: "Cần xem xét", businessDate: "Ngày KD", receiptTotal: "Tổng hóa đơn", gap: "Lệch",
    pos: "POS", ledger: "Sổ cái", paid: "Đã thanh toán", canceled: "Đã hủy", refunded: "Hoàn tiền", unpaid: "Chưa thanh toán",
    reflected: "Đã ghi", excluded: "Không tính", day_mismatch: "Lệch số tiền ngày", ledger_missing: "Chưa có sổ cái",
    dayCompare: "Thẻ trong ngày POS {pos} · Sổ cái {ledger}", open: "Chi tiết POS",
  },
} as const;
const number = (n: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n);
const money = (n: number) => `${number(n)} ₫`;
const signedNumber = (n: number) => n > 0 ? `+${number(n)}` : n < 0 ? `−${number(-n)}` : "0";
const signed = (n: number) => `${signedNumber(n)} ₫`;
const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;
const shortDate = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;

export default function CardFeeAnalysis({ fee, lang, notices = [], footer }: {
  fee: CardFeeView; lang: "ko" | "vi"; notices?: readonly string[]; footer?: ReactNode;
}) {
  const t = text[lang], estimate = fee.estimate, month = fee.month;
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<ScenarioKey>("target");
  const [lookups, setLookups] = useState<Record<string, Lookup>>({});
  const version = useRef(0);
  const scenarios = estimate?.scenarios ?? [];
  const amountFor = (key: ScenarioKey) => Math.round(Math.abs(scenarios.find(row => row.key === key)?.difference ?? 0));
  async function lookup(key: ScenarioKey) {
    const amount = amountFor(key), cacheKey = `${month}:${amount}`;
    if (amount <= 0 || lookups[cacheKey]?.candidates) return;
    const current = ++version.current;
    setLookups(prev => ({ ...prev, [cacheKey]: { loading: true, error: "", candidates: null } }));
    try {
      const r = await fetch(`/api/admin/ledger/card-fees/receipt-candidates?month=${month}&amount=${amount}`, { cache: "no-store" }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      if (current === version.current) setLookups(prev => ({ ...prev, [cacheKey]: { loading: false, error: "", candidates: b.candidates ?? [] } }));
    } catch (e) {
      if (current === version.current) setLookups(prev => ({ ...prev, [cacheKey]: { loading: false, error: (e as Error).message, candidates: null } }));
    }
  }
  const toggle = () => { const next = !open; setOpen(next); if (next) void lookup(scenario); };
  const choose = (key: ScenarioKey) => { setScenario(key); void lookup(key); };
  const selectedAmount = amountFor(scenario), selected = lookups[`${month}:${selectedAmount}`];

  // KPI numbers are the existing API values; nothing is recalculated here.
  const confirmed = Boolean(fee.closure);
  const kpiAmount = estimate?.currentEstimate ?? (confirmed ? fee.finalConfirmedFee ?? 0 : fee.projectedTotalFee);
  const kpiRate = estimate ? estimate.rate : confirmed ? fee.confirmedRate : fee.remainingRate;
  const rateOf = (key: ScenarioKey) => scenarios.find(row => row.key === key)?.rate ?? 0;
  const target = scenarios.find(row => row.key === "target");
  const outOfRange = estimate && (estimate.rangeStatus === "above" || estimate.rangeStatus === "below");
  const manualIds = estimate?.manualExpenses.map(row => `#${row.id}`).join(", ") ?? "";
  const chips: { label: string; tone: "ok" | "warn" | "muted" }[] = confirmed
    ? [{ label: `✅ ${t.official}`, tone: "ok" }, { label: fee.closure?.finalization_business_date ? t.auto : t.manualConfirm, tone: "muted" },
      { label: new Date(fee.closure!.confirmed_at).toLocaleDateString(lang === "vi" ? "vi-VN" : "ko-KR", { timeZone: "Asia/Ho_Chi_Minh" }), tone: "muted" }]
    : estimate?.provisionalManualOnly
      ? [{ label: `🧾 ${t.provisional} ${manualIds}`, tone: "warn" }, { label: `🛡️ ${t.protected}`, tone: "ok" }, { label: `⏳ ${t.notOfficial}`, tone: "muted" }]
      : [{ label: `⏳ ${t.notOfficial}`, tone: "muted" }, { label: fee.monthClosed ? `🔒 ${t.closed}` : t.beforeClose, tone: "muted" },
        ...(fee.monthClosed && estimate?.rangeStatus === "within" ? [{ label: t.nextDeposit, tone: "muted" as const }] : []),
        ...(outOfRange || fee.autoStatus === "review_required" ? [{ label: t.review, tone: "warn" as const }] : [])];
  return <div className={styles.feeUnified}>
    <div className={styles.grid}>
      <article className={styles.miniCard}><span>{confirmed ? t.confirmedKpi : t.estimated}</span><strong>{money(kpiAmount)}</strong></article>
      <article className={styles.miniCard}><span>{t.rate}</span><strong>{kpiRate == null ? "-" : percent(kpiRate)}</strong>
        {scenarios.length ? <small className={styles.kpiNote}>{t.reference} {percent(rateOf("min"))}~{percent(rateOf("max"))}</small> : null}</article>
    </div>
    {outOfRange && target ? <p role="status" className={styles.validation}>⚠️ {estimate.rangeStatus === "above" ? t.above : t.below} · {t.vsTarget} {signed(target.difference)}</p> : null}
    <p className={styles.chips}>{chips.map(chip => <span key={chip.label} className={chip.tone === "ok" ? styles.chipOk : chip.tone === "warn" ? styles.chipWarn : styles.chip}>{chip.label}</span>)}</p>
    {estimate?.duplicateRisk ? <p role="status" className={styles.validation}>{t.duplicate}</p> : null}
    {notices.map(notice => <p key={notice} role="status" className={styles.validation}>{notice}</p>)}
    {scenarios.length ? <table className={styles.feeTable}>
      <thead><tr><th scope="col">{t.basis}</th><th scope="col">{t.expected}</th><th scope="col">{t.difference}</th></tr></thead>
      <tbody>{scenarios.map(row => <tr key={row.key} className={row.key === "target" ? styles.feeTableTarget : undefined}>
        <th scope="row">{t[row.key]} {percent(row.rate)}</th><td>{number(row.expectedFee)}</td><td>{signedNumber(row.difference)}</td>
      </tr>)}</tbody>
    </table> : null}
    {scenarios.length ? <p className={styles.hint}>{t.differenceHint}</p> : null}
    {footer}
    <details className={styles.feeDetails}>
      <summary>{t.details}</summary>
      <dl className={styles.feeRows}>
        {estimate ? <div><dt>{t.gross}</dt><dd>{money(estimate.gross)}</dd></div> : null}
        <div className={styles.feeTotal}><dt>{t.confirmedTotal}</dt><dd>{money(confirmed ? fee.finalConfirmedFee ?? 0 : estimate?.confirmedFee ?? fee.historicalConfirmedFee)}</dd></div>
        <div><dt>{t.historicalPart}</dt><dd>{money(fee.historicalConfirmedFee)}</dd></div>
        {confirmed ? <div><dt>{t.monthEndPart}</dt><dd>{money(fee.monthEndFee)}</dd></div> : null}
        <div><dt>{t.unconfirmed}</dt><dd>{money(fee.currentOutstanding)}</dd></div>
        {estimate?.manualExpenseTotal ? <>
          <div className={styles.feeTotal}><dt>{t.manual} {manualIds}</dt><dd>{money(estimate.manualExpenseTotal)}</dd></div>
          <div><dt>{t.manualCovered}</dt><dd>{money(estimate.manualCoveredEstimate)}</dd></div>
          <div><dt>{t.unrecognized}</dt><dd>{money(estimate.unrecognizedEstimate)}</dd></div>
        </> : null}
      </dl>
      {estimate?.manualExpenses.filter(row => row.memo).map(row => <p key={row.id} className={styles.hint}>#{row.id} {row.memo}</p>)}
    </details>
    {scenarios.length ? <>
      <button type="button" className={`${styles.secondary} ${styles.reviewToggle}`} aria-expanded={open} aria-controls="card-fee-receipt-review" onClick={toggle}>{open ? "▾" : "▸"} {t.reviewTitle}</button>
      {open ? <div id="card-fee-receipt-review" className={styles.reviewPanel}>
        <p className={styles.hint}>{t.reviewHint}</p>
        <div className={styles.segmented} role="group" aria-label={t.pick}>{scenarios.map(row => <button key={row.key} type="button" aria-pressed={scenario === row.key} className={scenario === row.key ? styles.segmentActive : styles.segment} onClick={() => choose(row.key)}>{t[row.key]}<small>{signed(row.difference)}</small></button>)}</div>
        {selectedAmount <= 0 ? <p className={styles.empty}>{t.noDifference}</p>
          : !selected || selected.loading ? <p className={styles.empty}>{t.loading}</p>
            : selected.error ? <p role="status" className={styles.validation}>{t.failed}: {selected.error}</p>
              : !selected.candidates?.length ? <p className={styles.empty}>{t.empty}</p>
                : <ol className={styles.candidateList}>{selected.candidates.map(row => <li key={row.receiptId}>
                  <a className={styles.candidateLink} href={`/admin/sales/receipts?businessDate=${row.businessDate}&receiptId=${row.receiptId}`} aria-label={`${row.refNo ?? row.receiptId} ${t.open}`}>
                    <span className={styles.candidateHead}><span className={`${styles.statusBadge} ${styles.warningBadge}`}>{t.candidate}</span><b>#{row.refNo ?? row.receiptId}</b><strong>{money(row.cardAmount)}</strong></span>
                    <span className={styles.candidateMeta}>{t.businessDate} {shortDate(row.businessDate)} · {t.gap} {money(row.distance)} · {t.receiptTotal} {money(row.receiptFinalAmount)}</span>
                    <span className={styles.candidateMeta}>{[...row.cardNames, ...row.paymentMethods.filter(name => !row.cardNames.includes(name))].join(" · ") || "-"}</span>
                    <span className={styles.candidateMeta}>{t.pos} {t[row.posStatus]} · {t.ledger} {t[row.ledgerStatus]}</span>
                    {row.ledgerStatus === "day_mismatch" || row.ledgerStatus === "ledger_missing" ? <span className={styles.candidateMeta}>{t.dayCompare.replace("{pos}", money(row.posDayCardAmount)).replace("{ledger}", row.ledgerDayAmount === null ? "-" : money(row.ledgerDayAmount))}</span> : null}
                  </a>
                </li>)}</ol>}
      </div> : null}
    </> : null}
  </div>;
}
