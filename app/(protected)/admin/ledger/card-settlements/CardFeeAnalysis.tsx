"use client";
import { useRef, useState } from "react";
import styles from "./card-settlements.module.css";

// Read-only fee analysis under the card fee section. It never books, confirms or
// cancels anything; candidate receipts load only when the review panel is opened.
type ScenarioKey = "min" | "target" | "max";
export type CardFeeEstimateView = {
  gross: number; confirmedFee: number; unconfirmedEstimate: number; currentEstimate: number; rate: number | null;
  rangeStatus: "no_sales" | "below" | "within" | "above";
  scenarios: { key: ScenarioKey; rate: number; expectedFee: number; difference: number }[];
  manualExpenses: { id: number; amount: number; memo: string | null }[];
  manualExpenseTotal: number; manualCoveredEstimate: number; unrecognizedEstimate: number; duplicateRisk: boolean; provisionalManualOnly: boolean;
};
type Candidate = {
  receiptId: number; refNo: string | null; businessDate: string; cardAmount: number; receiptFinalAmount: number; distance: number;
  cardNames: string[]; paymentMethods: string[]; posStatus: "paid" | "canceled" | "refunded" | "unpaid";
  ledgerStatus: "reflected" | "excluded" | "day_mismatch" | "ledger_missing"; ledgerDayAmount: number | null; posDayCardAmount: number;
};
type Lookup = { loading: boolean; error: string; candidates: Candidate[] | null };
const text = {
  ko: {
    title: "수수료 추정 분석", gross: "월 카드매출", outstanding: "현재 미정산액", rate: "계산 수수료율",
    confirmed: "확정 수수료", unconfirmed: "미확정 추정액", estimate: "현재 수수료 추정액", estimateBadge: "추정",
    manual: "수기 비용 처리", manualCovered: "└ 추정액 중 수기 처리분", unrecognized: "└ 남은 미반영 추정액",
    provisional: "전표 {ids}는 잠정 수기 비용입니다. 공식 카드수수료 확정 기록이 아닙니다. 공식 확정 전에 수기 전표를 취소해야 중복계상을 막을 수 있습니다. 이 화면은 비용을 만들거나 전표를 취소하지 않습니다.",
    duplicate: "수기 비용이 미확정 추정액보다 크거나 공식 확정과 함께 있습니다. 중복계상 여부를 확인하세요.",
    closedNoClosure: "장부 마감 완료 · 공식 카드수수료 확정 기록 없음",
    below: "계산 수수료율 {rate}이 참고 범위({min}~{max})보다 낮습니다. 입금 중복이나 매출 누락이 있는지 확인하세요.",
    above: "계산 수수료율 {rate}이 참고 범위({min}~{max})를 넘습니다. 미입금 카드매출이나 POS 오류가 있는지 확인하세요.",
    within: "계산 수수료율이 참고 범위({min}~{max}) 안입니다. 비교 정보는 참고용입니다.",
    scenarioHead: "참고 기준별 예상 수수료", min: "최소", target: "목표", max: "최대", expected: "예상", difference: "차액",
    differenceHint: "차액 = 현재 추정액 − 기준 예상액. +는 추정액이 기준보다 큼",
    review: "POS 영수증 검토 후보", reviewHint: "선택한 차액과 카드결제액이 가까운 영수증입니다. 금액이 비슷하다는 것만으로 오류로 확정하지 않습니다.",
    pick: "기준 차액 선택", noDifference: "차액이 없어 조회할 후보가 없습니다.", loading: "불러오는 중…", failed: "조회 실패", empty: "카드결제 영수증이 없습니다.",
    candidate: "검토 후보", businessDate: "영업일", card: "카드결제", receiptTotal: "영수증 총액", gap: "차이",
    pos: "POS", ledger: "장부", paid: "결제완료", canceled: "취소", refunded: "환불", unpaid: "미결제",
    reflected: "반영", excluded: "제외 대상", day_mismatch: "일자 금액 불일치", ledger_missing: "장부 없음",
    dayCompare: "일 카드 POS {pos} · 장부 {ledger}", open: "POS 상세",
  },
  vi: {
    title: "Phân tích phí thẻ ước tính", gross: "Doanh thu thẻ tháng", outstanding: "Còn chưa quyết toán", rate: "Tỷ lệ phí tính được",
    confirmed: "Phí đã xác nhận", unconfirmed: "Ước tính chưa xác nhận", estimate: "Phí ước tính hiện tại", estimateBadge: "Ước tính",
    manual: "Đã ghi chi phí thủ công", manualCovered: "└ Phần ước tính đã ghi thủ công", unrecognized: "└ Ước tính còn chưa ghi",
    provisional: "Bút toán {ids} là chi phí thủ công tạm tính, không phải bản ghi xác nhận phí thẻ chính thức. Cần hủy bút toán thủ công trước khi xác nhận chính thức để tránh ghi trùng. Màn hình này không tạo chi phí và không hủy bút toán.",
    duplicate: "Chi phí thủ công lớn hơn phần ước tính chưa xác nhận hoặc tồn tại cùng xác nhận chính thức. Hãy kiểm tra ghi trùng.",
    closedNoClosure: "Đã chốt sổ · Chưa có bản ghi xác nhận phí thẻ chính thức",
    below: "Tỷ lệ phí {rate} thấp hơn khoảng tham chiếu ({min}~{max}). Hãy kiểm tra tiền về trùng hoặc thiếu doanh thu.",
    above: "Tỷ lệ phí {rate} vượt khoảng tham chiếu ({min}~{max}). Hãy kiểm tra doanh thu thẻ chưa về tiền hoặc lỗi POS.",
    within: "Tỷ lệ phí nằm trong khoảng tham chiếu ({min}~{max}). Thông tin so sánh chỉ để tham khảo.",
    scenarioHead: "Phí dự kiến theo mức tham chiếu", min: "Tối thiểu", target: "Mục tiêu", max: "Tối đa", expected: "Dự kiến", difference: "Chênh lệch",
    differenceHint: "Chênh lệch = ước tính hiện tại − phí dự kiến. Dấu + nghĩa là ước tính cao hơn",
    review: "Hóa đơn POS cần xem xét", reviewHint: "Hóa đơn có số tiền thanh toán thẻ gần với chênh lệch đã chọn. Số tiền gần nhau không có nghĩa là chắc chắn có lỗi.",
    pick: "Chọn chênh lệch", noDifference: "Không có chênh lệch nên không có hóa đơn để tìm.", loading: "Đang tải…", failed: "Tải thất bại", empty: "Không có hóa đơn thanh toán thẻ.",
    candidate: "Cần xem xét", businessDate: "Ngày KD", card: "Thanh toán thẻ", receiptTotal: "Tổng hóa đơn", gap: "Lệch",
    pos: "POS", ledger: "Sổ cái", paid: "Đã thanh toán", canceled: "Đã hủy", refunded: "Hoàn tiền", unpaid: "Chưa thanh toán",
    reflected: "Đã ghi", excluded: "Không tính", day_mismatch: "Lệch số tiền ngày", ledger_missing: "Chưa có sổ cái",
    dayCompare: "Thẻ trong ngày POS {pos} · Sổ cái {ledger}", open: "Chi tiết POS",
  },
} as const;
const money = (n: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n)} ₫`;
const signed = (n: number) => n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : money(0);
const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;
const shortDate = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}`;

export default function CardFeeAnalysis({ estimate, month, lang, monthClosed, hasClosure }: {
  estimate: CardFeeEstimateView; month: string; lang: "ko" | "vi"; monthClosed: boolean; hasClosure: boolean;
}) {
  const t = text[lang];
  const [open, setOpen] = useState(false);
  const [scenario, setScenario] = useState<ScenarioKey>("target");
  const [lookups, setLookups] = useState<Record<string, Lookup>>({});
  const version = useRef(0);
  const scenarios = estimate.scenarios;
  const rangeOf = (key: ScenarioKey) => percent(scenarios.find(row => row.key === key)?.rate ?? 0);
  const fill = (template: string) => template.replace("{rate}", estimate.rate === null ? "-" : percent(estimate.rate)).replace("{min}", rangeOf("min")).replace("{max}", rangeOf("max"));
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
  const manualIds = estimate.manualExpenses.map(row => `#${row.id}`).join(", ");
  return <div className={styles.analysis} aria-label={t.title}>
    <h3 className={styles.sectionTitle}>📊 {t.title}</h3>
    <dl className={styles.feeRows}>
      <div><dt>{t.gross}</dt><dd>{money(estimate.gross)}</dd></div>
      <div><dt>{t.outstanding}</dt><dd>{money(estimate.unconfirmedEstimate)}</dd></div>
      <div><dt>{t.rate}</dt><dd>{estimate.rate === null ? "-" : percent(estimate.rate)}</dd></div>
    </dl>
    <dl className={styles.feeRows}>
      <div><dt>{t.confirmed}</dt><dd>{money(estimate.confirmedFee)}</dd></div>
      <div><dt>{t.unconfirmed} <span className={`${styles.statusBadge} ${styles.warningBadge}`}>{t.estimateBadge}</span></dt><dd>{money(estimate.unconfirmedEstimate)}</dd></div>
      <div className={styles.feeTotal}><dt>{t.estimate}</dt><dd>{money(estimate.currentEstimate)}</dd></div>
    </dl>
    {estimate.manualExpenseTotal ? <dl className={styles.feeRows}>
      <div><dt>{t.manual} {manualIds}</dt><dd>{money(estimate.manualExpenseTotal)}</dd></div>
      <div><dt>{t.manualCovered}</dt><dd>{money(estimate.manualCoveredEstimate)}</dd></div>
      <div><dt>{t.unrecognized}</dt><dd>{money(estimate.unrecognizedEstimate)}</dd></div>
    </dl> : null}
    {monthClosed && !hasClosure ? <p className={styles.hint}>🔒 {t.closedNoClosure}</p> : null}
    {estimate.provisionalManualOnly ? <p role="note" className={styles.notice}>{t.provisional.replace("{ids}", manualIds)}</p> : null}
    {estimate.duplicateRisk ? <p role="status" className={styles.validation}>{t.duplicate}</p> : null}
    {estimate.rangeStatus === "below" || estimate.rangeStatus === "above"
      ? <p role="status" className={styles.validation}>⚠️ {fill(t[estimate.rangeStatus])}</p>
      : estimate.rangeStatus === "within" ? <p className={styles.hint}>{fill(t.within)}</p> : null}
    <p className={styles.scenarioHead}>{t.scenarioHead}</p>
    <ul className={styles.scenarioList}>{scenarios.map(row => <li key={row.key} className={styles.scenarioRow}>
      <span>{t[row.key]} {percent(row.rate)}</span>
      <span>{t.expected} <strong>{money(row.expectedFee)}</strong></span>
      <span>{t.difference} <strong>{signed(row.difference)}</strong></span>
    </li>)}</ul>
    <p className={styles.hint}>{t.differenceHint}</p>
    <button type="button" className={`${styles.secondary} ${styles.reviewToggle}`} aria-expanded={open} aria-controls="card-fee-receipt-review" onClick={toggle}>{open ? "▾" : "▸"} {t.review}</button>
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
  </div>;
}
