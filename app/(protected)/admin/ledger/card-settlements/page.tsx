"use client";
import { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import { BarField, BarSheet, keepingInputStyle, primaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { ledgerMonthHref, selectedLedgerMonth } from "@/lib/ledger/month-query";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import styles from "./card-settlements.module.css";
import { groupCardDeposits } from "@/lib/ledger/card-deposit-display";
import { CARD_AUTO_ALLOCATED_STATUS, planCardDepositAutoAllocation, sumCardMoney } from "@/lib/ledger/card-settlements";
import { formatLedgerAmountInput, parseLedgerAmount, sanitizeLedgerAmountInput } from "@/lib/ledger/manual-entry-amount";
type Account = { id: number; code: string; display_name: string };
type Sale = { id: number; business_date: string; amount: number; allocatedGrossAmount: number; outstandingGrossAmount: number };
type Rec = { id: number; deposit_date: string; deposit_amount: number; matched_gross_amount: number; difference_amount: number; status: string; confirmed_at: string | null; confirmed_by: number | null; cancelled_at: string | null; cancelled_by: number | null; cancel_reason: string | null; memo: string | null; destination: { display_name: string } | null };
type Data = { month:string; accounts: Account[]; sales: Sale[]; monthlySales: Sale[]; priorUnreconciledSales: Sale[]; totalReconciliationCount:number; totalHistoryCount:number; totalCancelledCount:number; reconciliations: Rec[]; summary: { monthlyCardGross: number; monthlyReconciledGross: number; monthlySettledGross:number; monthlyUnreconciledGross: number; totalUnreconciledGross: number; cardPendingBalance: number; actualCardDeposits: number; monthlyUnmatchedDeposits: number; monthlyCompletedGross: number; monthlyCompletedDeposit: number; monthlyCompletedDifference: number; actualDifferenceRate: number | null } };
type DepositLine = { id: number; pos_card_transaction_id: number; allocated_gross_amount: number | string; sale: { id: number; business_date: string; amount: number | string } | null };
const monthNow = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const localNow = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);
const money = (n: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n)} ₫`;
const shortDate = (date:string) => `${date.slice(5,7)}/${date.slice(8,10)}`;
const cardText = {
  ko: {
    title:"카드 정산",previous:"이전",next:"다음",previousMonth:"이전 달",nextMonth:"다음 달",selectMonth:"월 선택",
    cardStatus:"카드 현황",cardSales:"카드매출",monthEndSettled:"월말 정산완료",monthEndUnsettled:"월말 미정산",currentUnsettled:"현재 전체 미정산",
    priorUnsettled:"이전월 미정산",posDetail:"POS 상세",
    registerDeposit:"카드 입금 등록",depositHistory:"카드 입금 내역",deposit:"입금",unsettledCardSales:"미정산 카드매출",noDeposits:"등록된 카드 입금이 없습니다.",
    unmatched:"미연결",partial:"부분 연결",cancelled:"취소",depositTitle:"카드 입금",close:"닫기",depositDate:"입금일",depositAmount:"실제 입금액",memo:"메모",submitDeposit:"입금 등록",
    actualDeposit:"실제 입금",appliedToSales:"카드매출 반영",cancelDeposit:"입금 취소",confirmCancel:"취소 확정",back:"돌아가기",cancelRecord:"취소 기록",noReason:"사유 기록 없음",cancelReason:"취소 사유",
    depositOn:"입금",saleDate:"매출일",autoPreview:"자동 정산 미리보기",autoPreviewHint:"실제 입금액을 입력하면 오래된 미정산 카드매출부터 자동 정산합니다.",availableOutstanding:"정산 가능 미정산",thisSettlement:"이번 정산",totalSettlement:"총 정산",
    insufficientOutstanding:"미정산 카드매출 잔액이 실제 입금액보다 부족합니다.",invalidAmount:"실제 입금액을 확인해주세요.",noEligibleSales:"입금일 이전의 미정산 카드매출이 없습니다.",
    appliedSales:"반영된 카드매출",legacyHint:"카드매출에 자동 반영되지 않은 입금입니다. 필요하면 입금 취소 후 다시 등록하세요.",autoAppliedHint:"실제 입금액만큼 오래된 카드매출부터 자동 반영되었습니다.",
    posCardDetail:"POS 카드매출 상세",source:"원본",ledger:"장부",loading:"불러오는 중…",loadingPage:"카드 정산을 불러오는 중…",
    created:"카드 입금을 등록했습니다.",createdWithAllocations:"카드 입금을 등록하고 카드매출 {count}건을 자동 정산했습니다.",createFailed:"등록 실패",readFailed:"조회 실패",posFailed:"POS 조회 실패",cancelledMessage:"카드 입금을 취소하고 역분개했습니다.",cancelFailed:"취소 실패",
    cancelHint:"카드 입금 기록을 취소합니다. 입금 이동을 역분개하고 반영된 카드매출을 다시 미정산으로 돌립니다. 기록은 취소 이력으로 보존됩니다.",historicalDifferenceCancelHint:"이 입금에 기록된 과거 정산 차액도 함께 역분개됩니다.",
  },
  vi: {
    title:"Quyết toán thẻ",previous:"Trước",next:"Sau",previousMonth:"Tháng trước",nextMonth:"Tháng sau",selectMonth:"Chọn tháng",
    cardStatus:"Tình hình thẻ",cardSales:"Doanh thu thẻ",monthEndSettled:"Đã quyết toán cuối tháng",monthEndUnsettled:"Chưa quyết toán cuối tháng",currentUnsettled:"Tổng chưa quyết toán hiện tại",
    priorUnsettled:"Chưa quyết toán từ tháng trước",posDetail:"Chi tiết POS",
    registerDeposit:"Ghi nhận tiền thẻ",depositHistory:"Lịch sử tiền thẻ về",deposit:"Tiền về",unsettledCardSales:"Doanh thu thẻ chưa quyết toán",noDeposits:"Chưa có khoản tiền thẻ nào.",
    unmatched:"Chưa kết nối",partial:"Kết nối một phần",cancelled:"Đã hủy",depositTitle:"Tiền thẻ về",close:"Đóng",depositDate:"Ngày tiền về",depositAmount:"Số tiền thực nhận",memo:"Ghi chú",submitDeposit:"Ghi nhận",
    actualDeposit:"Tiền thực nhận",appliedToSales:"Trừ vào doanh thu thẻ",cancelDeposit:"Hủy tiền về",confirmCancel:"Xác nhận hủy",back:"Quay lại",cancelRecord:"Lịch sử hủy",noReason:"Không có lý do",cancelReason:"Lý do hủy",
    depositOn:"Tiền về",saleDate:"Ngày bán",autoPreview:"Xem trước quyết toán tự động",autoPreviewHint:"Nhập số tiền thực nhận để tự động quyết toán doanh thu thẻ cũ nhất trước.",availableOutstanding:"Có thể quyết toán",thisSettlement:"Lần này",totalSettlement:"Tổng quyết toán",
    insufficientOutstanding:"Số dư doanh thu thẻ chưa quyết toán nhỏ hơn số tiền thực nhận.",invalidAmount:"Hãy kiểm tra số tiền thực nhận.",noEligibleSales:"Không có doanh thu thẻ chưa quyết toán trước ngày tiền về.",
    appliedSales:"Doanh thu thẻ đã trừ",legacyHint:"Khoản tiền về chưa được trừ tự động vào doanh thu thẻ. Nếu cần, hủy tiền về rồi ghi nhận lại.",autoAppliedHint:"Đã tự động trừ vào doanh thu thẻ cũ nhất trước, đúng bằng số tiền thực nhận.",
    posCardDetail:"Chi tiết doanh thu thẻ POS",source:"Nguồn",ledger:"Sổ cái",loading:"Đang tải…",loadingPage:"Đang tải quyết toán thẻ…",
    created:"Đã ghi nhận tiền thẻ.",createdWithAllocations:"Đã ghi nhận tiền thẻ và tự động quyết toán {count} doanh thu thẻ.",createFailed:"Ghi nhận thất bại",readFailed:"Tải thất bại",posFailed:"Tải chi tiết POS thất bại",cancelledMessage:"Đã hủy tiền thẻ về và ghi bút toán đảo.",cancelFailed:"Hủy thất bại",
    cancelHint:"Hủy bản ghi tiền thẻ về. Bút toán tiền về sẽ được đảo và doanh thu thẻ đã trừ trở lại trạng thái chưa quyết toán. Lịch sử được giữ lại.",historicalDifferenceCancelHint:"Chênh lệch quyết toán cũ của khoản này cũng sẽ được đảo.",
  },
} as const;
type CardText = typeof cardText["ko"] | typeof cardText["vi"];
// Normal deposits (matched / auto_allocated) carry no badge; only exceptional states are labelled.
const exceptionLabel = (status:string,text:CardText) => status==="unmatched"?text.unmatched:status==="partial"?text.partial:status==="cancelled"?text.cancelled:null;
const isLegacyPending = (status:string) => status==="unmatched"||status==="partial";
const monthNoticeCardStyle: CSSProperties = { padding: "10px 12px", borderRadius: 10, background: "#f9fafb", border: "1px solid #e5e7eb" };
const monthControlStyle: CSSProperties = { marginTop: 8, display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8 };
const monthButtonStyle: CSSProperties = { ...ui.button, padding: "9px 10px", borderRadius: 10, fontSize: 12, fontWeight: 800 };
const monthInputStyle: CSSProperties = { ...ui.input, width: "100%", minWidth: 0, padding: "9px 10px", fontSize: 13, borderRadius: 10 };
function CardSettlementsContent() {
  const {lang}=useLanguage(), t=cardText[lang];
  const router=useRouter(), pathname=usePathname(), searchParams=useSearchParams();
  const month=selectedLedgerMonth(searchParams.get("month"),monthNow());
  const [loadedData, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState(""), [working, setWorking] = useState(false);
  const [depositAt, setDepositAt] = useState(localNow), [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [drilldown, setDrilldown] = useState<Record<string, unknown> | null>(null);
  const [createOpen,setCreateOpen]=useState(false), [inspectedDeposit,setInspectedDeposit]=useState<Rec|null>(null);
  const [cancelOpen,setCancelOpen]=useState(false), [cancelReason,setCancelReason]=useState("");
  const [depositLines,setDepositLines]=useState<DepositLine[]|null>(null);
  const data=loadedData?.month===month?loadedData:null;
  const createButtonRef=useRef<HTMLButtonElement>(null), depositButtonRef=useRef<HTMLButtonElement|null>(null);
  const inspectVersion = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch(`/api/admin/ledger/card-settlements?month=${month}`, { cache: "no-store", signal }), b = await r.json();
    if (!r.ok) throw new Error(b.code);
    if (!signal?.aborted) setData(b);
  }, [month]);
  useEffect(() => {
    ++inspectVersion.current;setData(null);setInspectedDeposit(null);setDepositLines(null);setCancelOpen(false);setCancelReason("");setCreateOpen(false);setDrilldown(null);setMessage("");
    const controller = new AbortController();
    void load(controller.signal).catch(e => { if (!controller.signal.aborted) setMessage(`${t.readFailed}: ${e.message}`); });
    return () => controller.abort();
  }, [load,t]);
  function selectMonth(nextMonth:string) {
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(nextMonth))return;
    ++inspectVersion.current;setData(null);setInspectedDeposit(null);setDepositLines(null);setCancelOpen(false);setCancelReason("");setCreateOpen(false);setDrilldown(null);setMessage("");
    router.push(ledgerMonthHref(pathname,searchParams.toString(),nextMonth),{scroll:false});
  }
  function shiftMonth(delta:number) {
    const date=new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth()+delta);
    selectMonth(date.toISOString().slice(0,7));
  }
  // Same FIFO contract as ledger_create_card_deposit_auto_allocate_v1; the RPC re-plans under lock on save.
  const plan = planCardDepositAutoAllocation(data?.sales ?? [], parseLedgerAmount(amount) ?? 0, depositAt.slice(0,10));
  async function create(e: FormEvent) {
    e.preventDefault();
    const depositAmount = parseLedgerAmount(amount);
    if (depositAmount === null || plan.error) return;
    setWorking(true);
    try {
      const r = await fetch("/api/admin/ledger/card-settlements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ depositAt: `${depositAt}:00+07:00`, amount: depositAmount, memo }) }), b = await r.json();
      if (!r.ok) throw new Error(b.code === "INSUFFICIENT_UNSETTLED_CARD_SALES" ? t.insufficientOutstanding : b.code);
      const allocated = Array.isArray(b.result?.allocations) ? b.result.allocations.length : 0;
      setAmount(""); setMemo(""); setCreateOpen(false); setMessage(allocated ? t.createdWithAllocations.replace("{count}", String(allocated)) : t.created); await load();
    } catch (e) { setMessage(`${t.createFailed}: ${(e as Error).message}`); } finally { setWorking(false); }
  }
  async function inspect(row: Rec) {
    const version = ++inspectVersion.current;
    setMessage(""); setCancelOpen(false); setCancelReason(""); setDepositLines(null); setInspectedDeposit(row);
    try {
      const r = await fetch(`/api/admin/ledger/card-settlements/${row.id}`, { cache: "no-store" }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      if (version === inspectVersion.current) setDepositLines(b.reconciliation.lines ?? []);
    } catch (e) { if (version === inspectVersion.current) setMessage(`${t.readFailed}: ${(e as Error).message}`); }
  }
  const closeInspected = () => { ++inspectVersion.current; setInspectedDeposit(null); setDepositLines(null); setCancelOpen(false); setCancelReason(""); };
  const inspectedGross=Number(inspectedDeposit?.matched_gross_amount);
  // Historical matched rows may carry a booked difference; cancelling reverses it too.
  const inspectedHasDifference=Number(inspectedDeposit?.difference_amount)>0;
  const inspectedWasAuto=inspectedDeposit?.status===CARD_AUTO_ALLOCATED_STATUS;
  async function openPos(id: number) {
    try {
      const r = await fetch(`/api/admin/ledger/transactions/${id}/pos-drilldown`, { cache: "no-store" }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      setDrilldown(b.drilldown);
    } catch (e) { setMessage(`${t.posFailed}: ${(e as Error).message}`); }
  }
  async function cancelReconciliation() {
    if (!inspectedDeposit || inspectedDeposit.status === "cancelled" || !cancelReason.trim()) return;
    setWorking(true);
    try {
      const r = await fetch(`/api/admin/ledger/card-settlements/${inspectedDeposit.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason.trim() }),
      }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      setMessage(t.cancelledMessage);
      closeInspected();
      await load();
    } catch (e) {
      setMessage(`${t.cancelFailed}: ${(e as Error).message}`);
    } finally {
      setWorking(false);
    }
  }
  const depositGroups = groupCardDeposits(data?.reconciliations ?? [], month);
  // Deposit rows show deposit_date; sale rows show business_date. Label both so equal dates are not read as one state.
  const depositDateLabel = (date:string) => lang==="vi" ? `${t.depositOn} ${shortDate(date)}` : `${shortDate(date)} ${t.depositOn}`;
  const saleDateLabel = (date:string) => `${t.saleDate} ${shortDate(date)}`;
  function renderDeposit(row: Rec) {
    const exception = exceptionLabel(row.status,t);
    return <article key={row.id} className={`${styles.depositRow} ${styles.compactDeposit}`}>
      <button type="button" disabled={working} className={styles.depositDetail} onClick={e=>{depositButtonRef.current=e.currentTarget;void inspect(row);}}>
        <time dateTime={row.deposit_date}>{depositDateLabel(row.deposit_date)}</time><strong>{money(Number(row.deposit_amount))}</strong>
      </button>
      {exception?<span className={`${styles.statusBadge} ${row.status==="cancelled"?styles.cancelledBadge:styles.warningBadge}`}>{exception}</span>:null}
      <button type="button" disabled={working} className={styles.detailChevron} aria-label={`${row.deposit_date} ${t.depositTitle}`} onClick={e=>{depositButtonRef.current=e.currentTarget;void inspect(row);}}>›</button>
    </article>;
  }
  return <Container noPaddingTop noPaddingBottom><main className={styles.page}>
    <header className={styles.header}><h1>{t.title}</h1></header>
    <section style={monthNoticeCardStyle} aria-label={t.selectMonth}><div style={monthControlStyle}>
      <button type="button" disabled={working} onClick={()=>shiftMonth(-1)} aria-label={t.previousMonth} style={monthButtonStyle}>{t.previous}</button>
      <input type="month" disabled={working} value={month} onChange={e=>selectMonth(e.target.value)} aria-label={t.selectMonth} style={monthInputStyle}/>
      <button type="button" disabled={working} onClick={()=>shiftMonth(1)} aria-label={t.nextMonth} style={monthButtonStyle}>{t.next}</button>
    </div></section>
    {message&&!createOpen&&!inspectedDeposit?<p role="status" className={styles.notice}>{message}</p>:null}
    {data?<>
      <section className={styles.card} aria-label={lang==="vi"?"Theo tháng bán thẻ":"카드매출 발생월 기준"}>
        <h2>{t.cardStatus} ({lang==="vi"?`T${Number(month.slice(5,7))}`:`${Number(month.slice(5,7))}월`})</h2>
        <div className={styles.grid}>
          <Card title={`💳 ${t.cardSales}`} value={money(data.summary.monthlyCardGross)}/>
          <Card title={`✅ ${t.monthEndSettled}`} value={money(data.summary.monthlySettledGross)}/>
          <Card title={`⏳ ${t.monthEndUnsettled}`} value={money(data.summary.monthlyUnreconciledGross)}/>
          <Card title={`🌐 ${t.currentUnsettled}`} value={money(data.summary.totalUnreconciledGross)}/>
        </div>
      </section>
      {data.priorUnreconciledSales.length?<p className={styles.hint}>↪️ {t.priorUnsettled} {money(sumCardMoney(data.priorUnreconciledSales.map(sale=>sale.outstandingGrossAmount)))}</p>:null}
      <button ref={createButtonRef} type="button" disabled={working} className={styles.primary} style={{width:"100%"}} onClick={()=>{setMessage("");setCreateOpen(true);}}>＋ {t.registerDeposit}</button>
      <section className={styles.card} aria-label={lang==="vi"?"Theo tháng tiền thẻ về":"카드입금월 기준"}>
        <h2>🏦 {t.depositHistory}</h2>
        {/* Unsettled card sales is the current outstanding balance, not a confirmed card fee. */}
        <dl className={styles.depositTotals}><div><dt>{t.deposit}</dt><dd>{money(data.summary.actualCardDeposits)}</dd></div><div><dt>{t.unsettledCardSales}</dt><dd>{money(data.summary.totalUnreconciledGross)}</dd></div></dl>
        {data.reconciliations.length===0?<p className={styles.empty}>{t.noDeposits}</p>:<div className={styles.list}>
          {depositGroups.deposits.map(renderDeposit)}
          {depositGroups.cancelled.map(renderDeposit)}
        </div>}
      </section>
      {createOpen?<BarSheet kind="full" compact title={t.registerDeposit} closeLabel={t.close} saving={working} onClose={()=>setCreateOpen(false)} returnFocusRef={createButtonRef} footer={<button form="card-deposit-form" type="submit" disabled={working||plan.error!==null} className={styles.primary} style={{...primaryButtonStyle,width:"100%"}}>{t.submitDeposit}</button>}>
        {message?<p role="status" className={styles.notice}>{message}</p>:null}
        <form id="card-deposit-form" onSubmit={create} className={styles.formGrid}>
          <BarField label={`📅 ${t.depositDate}`} required>{({id})=><input id={id} required type="datetime-local" disabled={working} value={depositAt} onChange={e=>setDepositAt(e.target.value)} style={keepingInputStyle}/>}</BarField>
          <BarField label={`💵 ${t.depositAmount}`} required>{({id})=><input id={id} required inputMode="numeric" autoComplete="off" disabled={working} value={formatLedgerAmountInput(amount)} onChange={e=>setAmount(sanitizeLedgerAmountInput(e.target.value))} style={keepingInputStyle}/>}</BarField>
          <section className={styles.preview} aria-live="polite" aria-label={t.autoPreview}>
            <strong>💡 {t.autoPreview}</strong>
            {!amount?<>
              <p>{t.autoPreviewHint}</p>
              <p>{t.availableOutstanding} {money(plan.availableOutstanding)}</p>
            </>:plan.error==="exceeds_outstanding"?<p role="alert" className={styles.validation}>{t.insufficientOutstanding} ({t.availableOutstanding} {money(plan.availableOutstanding)})</p>
            :plan.error==="nothing_outstanding"?<p role="alert" className={styles.validation}>{t.noEligibleSales}</p>
            :plan.error?<p role="alert" className={styles.validation}>{t.invalidAmount}</p>
            :<>
              <ol className={styles.previewRows}>{plan.rows.map(row=><li key={row.transactionId}>
                <div><time dateTime={row.businessDate}>{saleDateLabel(row.businessDate)}</time><span>{t.thisSettlement} <strong>{money(row.allocatedAmount)}</strong></span></div>
                <div className={styles.previewBalance}>{money(row.outstandingBefore)} → {money(row.outstandingAfter)}</div>
              </li>)}</ol>
              <p className={styles.previewTotal}>{t.totalSettlement} <strong>{money(plan.totalAllocated)}</strong> = {t.actualDeposit}</p>
            </>}
          </section>
          <BarField label={`📝 ${t.memo}`}>{({id})=><input id={id} disabled={working} value={memo} onChange={e=>setMemo(e.target.value)} style={keepingInputStyle}/>}</BarField>
        </form>
      </BarSheet>:null}
      {inspectedDeposit?<BarSheet kind="full" compact title={`${inspectedDeposit.deposit_date} ${t.depositTitle}`} closeLabel={t.close} saving={working} onClose={closeInspected} returnFocusRef={depositButtonRef} footer={inspectedDeposit.status==="cancelled"?<button type="button" className={styles.secondary} onClick={closeInspected}>{t.close}</button>:cancelOpen?<div className={styles.actions}><button type="button" disabled={working} className={styles.secondary} onClick={()=>{setCancelOpen(false);setCancelReason("");}}>{t.back}</button><button type="button" disabled={working||!cancelReason.trim()} className={styles.danger} onClick={()=>void cancelReconciliation()}>{t.confirmCancel}</button></div>:<div className={styles.actions}><button type="button" disabled={working} className={styles.danger} onClick={()=>{setMessage("");setCancelOpen(true);}}>{t.cancelDeposit}</button><button type="button" className={styles.secondary} onClick={closeInspected}>{t.close}</button></div>}>
        {message?<p role="status" className={styles.notice}>{message}</p>:null}
        {/* matched and auto_allocated share one layout: the gross applied to sales is shown as stored. */}
        <div className={styles.grid}><Card title={t.actualDeposit} value={money(Number(inspectedDeposit.deposit_amount))}/><Card title={t.appliedToSales} value={money(inspectedGross)}/></div>
        <p className={styles.hint}>{inspectedDeposit.destination?.display_name??"-"}</p>{inspectedDeposit.memo?<p className={styles.hint}>{inspectedDeposit.memo}</p>:null}
        {inspectedWasAuto?<p className={styles.hint}>{t.autoAppliedHint}</p>:null}
        {isLegacyPending(inspectedDeposit.status)?<p className={styles.notice}>{t.legacyHint}</p>:null}
        {depositLines?.length?<section aria-label={t.appliedSales}><h3 className={styles.sectionTitle}>{t.appliedSales}</h3><div className={styles.list}>{depositLines.map(line=><article key={line.id} className={styles.saleRow}>
          <div className={styles.saleHeading}>{line.sale?<time dateTime={line.sale.business_date}>{saleDateLabel(line.sale.business_date)}</time>:<span>#{line.pos_card_transaction_id}</span>}<strong>{money(Number(line.allocated_gross_amount))}</strong><button type="button" className={styles.secondary} onClick={()=>void openPos(Number(line.pos_card_transaction_id))}>{t.posDetail}</button></div>
        </article>)}</div></section>:null}
        {inspectedDeposit.status==="cancelled"?<div className={styles.cancelRecord}><strong>{t.cancelRecord}</strong><p>{inspectedDeposit.cancel_reason??t.noReason}</p><small>{inspectedDeposit.cancelled_at?new Date(inspectedDeposit.cancelled_at).toLocaleString(lang==="vi"?"vi-VN":"ko-KR",{timeZone:"Asia/Ho_Chi_Minh"}):"-"}</small></div>:null}
        {cancelOpen?<div className={styles.cancelPanel}>
          <p>{t.cancelHint}{inspectedHasDifference?` ${t.historicalDifferenceCancelHint}`:""}</p>
          <label>{t.cancelReason}<textarea required disabled={working} value={cancelReason} onChange={e=>setCancelReason(e.target.value)} className={styles.input} rows={3}/></label>
        </div>:null}
      </BarSheet>:null}
      {drilldown?<BarSheet kind="full" compact topAligned title={t.posCardDetail} closeLabel={t.close} onClose={()=>setDrilldown(null)} footer={<button type="button" className={styles.secondary} onClick={()=>setDrilldown(null)}>{t.close}</button>}>
        <p className={styles.hint}>{t.source} {money(Number(drilldown.sourceAmount??0))} · {t.ledger} {money(Number(drilldown.ledgerAmount??0))}</p>
        {((drilldown.payments as Array<Record<string,unknown>>)||[]).map((payment,i)=><p className={styles.hint} key={String(payment.paymentId??i)}>{String(payment.refNo??"-")} · {String(payment.refDate??"-")} · {String(payment.paymentMethod??"-")} · {money(Number(payment.paymentAmount??0))}</p>)}
      </BarSheet>:null}
    </>:<p className={styles.empty}>{t.loading}</p>}
  </main></Container>;
}
export default function CardSettlementsPage() {
  const {lang}=useLanguage();
  return <Suspense fallback={<Container><main>{cardText[lang].loadingPage}</main></Container>}><CardSettlementsContent/></Suspense>;
}
function Card({title,value}:{title:string;value:string}) {return <article className={styles.miniCard}><span>{title}</span><strong>{value}</strong></article>;}
