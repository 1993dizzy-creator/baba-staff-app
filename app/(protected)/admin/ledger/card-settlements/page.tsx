"use client";
import { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import { BarField, BarSheet, keepingInputStyle, primaryButtonStyle } from "@/components/bar/keeping/KeepingUi";
import { ledgerMonthHref, selectedLedgerMonth } from "@/lib/ledger/month-query";
import { useLanguage } from "@/lib/language-context";
import { ui } from "@/lib/styles/ui";
import styles from "./card-settlements.module.css";
import { buildEditableCardSales, cardMoney, eligibleCardSalesForDeposit, recommendCardAllocations, sumCardMoney } from "@/lib/ledger/card-settlements";
type Account = { id: number; code: string; display_name: string };
type Sale = { id: number; business_date: string; amount: number; allocatedGrossAmount: number; outstandingGrossAmount: number };
type Rec = { id: number; deposit_date: string; deposit_amount: number; matched_gross_amount: number; difference_amount: number; status: string; confirmed_at: string | null; confirmed_by: number | null; cancelled_at: string | null; cancelled_by: number | null; cancel_reason: string | null; memo: string | null; destination: { display_name: string } | null };
type Data = { month:string; accounts: Account[]; sales: Sale[]; monthlySales: Sale[]; priorUnreconciledSales: Sale[]; totalReconciliationCount:number; totalHistoryCount:number; totalCancelledCount:number; reconciliations: Rec[]; summary: { monthlyCardGross: number; monthlyReconciledGross: number; monthlySettledGross:number; monthlyUnreconciledGross: number; totalUnreconciledGross: number; cardPendingBalance: number; actualCardDeposits: number; monthlyUnmatchedDeposits: number; monthlyCompletedGross: number; monthlyCompletedDeposit: number; monthlyCompletedDifference: number; actualDifferenceRate: number | null } };
type SavedLine = { pos_card_transaction_id: number; allocated_gross_amount: number; sale: Sale | null };
const monthNow = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
const localNow = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16);
const money = (n: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(n)} ₫`;
const shortDate = (date:string) => `${date.slice(5,7)}/${date.slice(8,10)}`;
const cardText = {
  ko: {
    title:"카드 정산",previous:"이전",next:"다음",previousMonth:"이전 달",nextMonth:"다음 달",selectMonth:"월 선택",month:"월",
    cardStatus:"카드 현황",cardSales:"카드매출",monthEndSettled:"월말 정산완료",monthEndUnsettled:"월말 미정산",currentUnsettled:"현재 전체 미정산",
    unsettledSales:"미정산 카드매출",priorUnsettled:"이전월 미정산",noMonthSales:"선택월 카드매출이 없습니다.",noPriorSales:"이전월 미정산이 없습니다.",
    statusHint:"상단 금액은 선택월 말 기준입니다. 아래 매출별 연결 현황은 현재 기준이며 부분 저장을 포함합니다.",posDetail:"POS 상세",
    registerDeposit:"카드 입금 등록",depositHistory:"카드 입금 내역",deposit:"입금",difference:"차액",averageFee:"평균 수수료",noDeposits:"등록된 카드 입금이 없습니다.",
    unmatched:"미연결",partial:"부분 저장",matched:"정산 완료",cancelled:"취소",depositTitle:"카드 입금",close:"닫기",depositDate:"입금일",depositAmount:"실제 입금액",depositAccount:"입금계정",choose:"선택",memo:"메모",submitDeposit:"입금 등록",
    actualDeposit:"실제 입금",settlementAmount:"정산금액",estimatedFee:"정산 차액 & 추정 수수료",status:"상태",cancelSettlement:"정산 취소",confirmCancel:"취소 확정",back:"돌아가기",cancelRecord:"취소 기록",noReason:"사유 기록 없음",cancelReason:"취소 사유",
    matchSales:"매출 연결",edit:"수정",settlementTarget:"정산 대상",settlementDifference:"정산 차액",differenceRate:"정산 차액률",expectedFee:"예상 수수료율 (%)",recommendOldest:"오래된 매출부터 추천",savePartial:"부분 저장",confirmSettlement:"정산 확정",allocation:"연결액",
    confirmPreview:"정산 확정 전 확인",recommendHint:"예상 수수료율은 추천용 · 입력액은 현재 입금의 연결액",allocationValidation:"연결액은 미정산 잔액 이하, 소수점 3자리까지 입력해주세요.",partialOnly:"정산 대상이 입금액보다 작습니다. 부분 저장만 가능합니다.",noEligibleSales:"연결 가능한 미정산 매출이 없습니다.",posCardDetail:"POS 카드매출 상세",source:"원본",ledger:"장부",loading:"불러오는 중…",loadingPage:"카드 정산을 불러오는 중…",saleAllocated:"정산완료",saleRemaining:"미정산",allocatedHint:"부분 저장 포함 연결액",
    created:"카드 입금을 등록했습니다.",createFailed:"등록 실패",readFailed:"조회 실패",savedLines:"기존 부분 연결을 불러왔습니다. 저장 시 이 정산의 연결액을 교체합니다.",recommendTarget:"추천 정산 대상",insufficientSales:"매출 잔액 부족",checkAllocation:"연결액을 확인해주세요.",checkDifference:"확정 전 연결액과 차액률을 확인해주세요.",matchFailed:"매칭 실패",posFailed:"POS 조회 실패",cancelledMessage:"카드 입금 정산을 취소하고 역분개했습니다.",cancelFailed:"취소 실패",invalidReconciliation:"이미 확정되었거나 유효하지 않은 정산입니다.",invalidFee:"예상 수수료율을 0 이상 100 미만으로 입력해주세요.",partialSaved:"부분 매칭을 저장했습니다.",futureSale:"입금일 이후의 카드매출은 이 입금에 연결할 수 없습니다.",saleDate:"매출일",completedDifference:"정산 완료 · 차액",matchedCancelHint:"카드 입금 이동과 정산 차액을 역분개하고 연결된 카드매출을 다시 미정산 상태로 돌립니다.",partialCancelHint:"카드 입금 이동을 역분개합니다. 저장된 매출 연결은 삭제하지 않고 취소 이력으로 보존되며, 카드매출은 다시 연결할 수 있습니다.",
  },
  vi: {
    title:"Quyết toán thẻ",previous:"Trước",next:"Sau",previousMonth:"Tháng trước",nextMonth:"Tháng sau",selectMonth:"Chọn tháng",month:"T",
    cardStatus:"Tình hình thẻ",cardSales:"Doanh thu thẻ",monthEndSettled:"Đã quyết toán cuối tháng",monthEndUnsettled:"Chưa quyết toán cuối tháng",currentUnsettled:"Tổng chưa quyết toán hiện tại",
    unsettledSales:"Doanh thu thẻ chưa quyết toán",priorUnsettled:"Chưa quyết toán từ tháng trước",noMonthSales:"Không có doanh thu thẻ trong tháng đã chọn.",noPriorSales:"Không có khoản chưa quyết toán từ tháng trước.",
    statusHint:"Số tiền trên tính đến cuối tháng đã chọn. Chi tiết kết nối bên dưới theo trạng thái hiện tại và bao gồm phần đã lưu.",posDetail:"Chi tiết POS",
    registerDeposit:"Ghi nhận tiền thẻ",depositHistory:"Lịch sử tiền thẻ về",deposit:"Tiền về",difference:"Chênh lệch",averageFee:"Phí trung bình",noDeposits:"Chưa có khoản tiền thẻ nào.",
    unmatched:"Chưa kết nối",partial:"Đã lưu một phần",matched:"Đã quyết toán",cancelled:"Đã hủy",depositTitle:"Tiền thẻ về",close:"Đóng",depositDate:"Ngày tiền về",depositAmount:"Số tiền thực nhận",depositAccount:"Tài khoản nhận",choose:"Chọn",memo:"Ghi chú",submitDeposit:"Ghi nhận",
    actualDeposit:"Tiền thực nhận",settlementAmount:"Số tiền quyết toán",estimatedFee:"Chênh lệch & phí ước tính",status:"Trạng thái",cancelSettlement:"Hủy quyết toán",confirmCancel:"Xác nhận hủy",back:"Quay lại",cancelRecord:"Lịch sử hủy",noReason:"Không có lý do",cancelReason:"Lý do hủy",
    matchSales:"Kết nối doanh thu",edit:"sửa",settlementTarget:"Doanh thu quyết toán",settlementDifference:"Chênh lệch quyết toán",differenceRate:"Tỷ lệ chênh lệch",expectedFee:"Phí dự kiến (%)",recommendOldest:"Gợi ý từ doanh thu cũ nhất",savePartial:"Lưu một phần",confirmSettlement:"Xác nhận quyết toán",allocation:"Số tiền kết nối",
    confirmPreview:"Kiểm tra trước khi quyết toán",recommendHint:"Tỷ lệ phí dự kiến chỉ dùng để gợi ý · số tiền nhập là phần kết nối với khoản tiền về này",allocationValidation:"Số tiền kết nối không vượt quá số dư chưa quyết toán và tối đa 3 chữ số thập phân.",partialOnly:"Doanh thu quyết toán nhỏ hơn tiền thực nhận. Chỉ có thể lưu một phần.",noEligibleSales:"Không có doanh thu chưa quyết toán phù hợp.",posCardDetail:"Chi tiết doanh thu thẻ POS",source:"Nguồn",ledger:"Sổ cái",loading:"Đang tải…",loadingPage:"Đang tải quyết toán thẻ…",saleAllocated:"Đã kết nối",saleRemaining:"Chưa quyết toán",allocatedHint:"Bao gồm phần đã lưu",
    created:"Đã ghi nhận tiền thẻ.",createFailed:"Ghi nhận thất bại",readFailed:"Tải thất bại",savedLines:"Đã tải phần kết nối trước đó. Khi lưu, số tiền kết nối của khoản này sẽ được thay thế.",recommendTarget:"Doanh thu gợi ý",insufficientSales:"Thiếu số dư doanh thu",checkAllocation:"Hãy kiểm tra số tiền kết nối.",checkDifference:"Hãy kiểm tra số tiền kết nối và tỷ lệ chênh lệch trước khi xác nhận.",matchFailed:"Kết nối thất bại",posFailed:"Tải chi tiết POS thất bại",cancelledMessage:"Đã hủy quyết toán tiền thẻ và ghi bút toán đảo.",cancelFailed:"Hủy thất bại",invalidReconciliation:"Khoản quyết toán đã được xác nhận hoặc không còn hợp lệ.",invalidFee:"Nhập tỷ lệ phí dự kiến từ 0 đến dưới 100.",partialSaved:"Đã lưu phần kết nối.",futureSale:"Không thể kết nối doanh thu thẻ sau ngày tiền về với khoản này.",saleDate:"Ngày bán",completedDifference:"Đã quyết toán · chênh lệch",matchedCancelHint:"Bút toán tiền thẻ về và chênh lệch sẽ được đảo; doanh thu thẻ đã kết nối sẽ trở lại trạng thái chưa quyết toán.",partialCancelHint:"Bút toán tiền thẻ về sẽ được đảo. Phần kết nối đã lưu được giữ trong lịch sử hủy và có thể kết nối lại doanh thu thẻ.",
  },
} as const;
type CardText = typeof cardText["ko"] | typeof cardText["vi"];
const statusName = (status:string,text:CardText) => ({unmatched:text.unmatched,partial:text.partial,matched:text.matched,cancelled:text.cancelled} as Record<string,string>)[status]??status;
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
  const [depositAt, setDepositAt] = useState(localNow), [amount, setAmount] = useState(""), [accountId, setAccountId] = useState("");
  const [memo, setMemo] = useState("");
  const [selected, setSelected] = useState<number | null>(null), [allocations, setAllocations] = useState<Record<number, string>>({});
  const [editableSales, setEditableSales] = useState<Sale[]>([]), [expectedFee, setExpectedFee] = useState("1.8");
  const [drilldown, setDrilldown] = useState<Record<string, unknown> | null>(null);
  const [createOpen,setCreateOpen]=useState(false), [inspectedDeposit,setInspectedDeposit]=useState<Rec|null>(null);
  const [cancelOpen,setCancelOpen]=useState(false), [cancelReason,setCancelReason]=useState("");
  const data=loadedData?.month===month?loadedData:null;
  const createButtonRef=useRef<HTMLButtonElement>(null), depositButtonRef=useRef<HTMLButtonElement|null>(null);
  const openVersion = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const r = await fetch(`/api/admin/ledger/card-settlements?month=${month}`, { cache: "no-store", signal }), b = await r.json();
    if (!r.ok) throw new Error(b.code);
    if (!signal?.aborted) setData(b);
  }, [month]);
  useEffect(() => {
    ++openVersion.current;setData(null);setSelected(null);setAllocations({});setEditableSales([]);setInspectedDeposit(null);setCancelOpen(false);setCancelReason("");setCreateOpen(false);setDrilldown(null);setMessage("");
    const controller = new AbortController();
    void load(controller.signal).catch(e => { if (!controller.signal.aborted) setMessage(`${t.readFailed}: ${e.message}`); });
    return () => controller.abort();
  }, [load,t]);
  function selectMonth(nextMonth:string) {
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(nextMonth))return;
    ++openVersion.current;setData(null);setSelected(null);setAllocations({});setEditableSales([]);setInspectedDeposit(null);setCancelOpen(false);setCancelReason("");setCreateOpen(false);setDrilldown(null);setMessage("");
    router.push(ledgerMonthHref(pathname,searchParams.toString(),nextMonth),{scroll:false});
  }
  function shiftMonth(delta:number) {
    const date=new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth()+delta);
    selectMonth(date.toISOString().slice(0,7));
  }
  async function create(e: FormEvent) {
    e.preventDefault(); setWorking(true);
    try {
      const r = await fetch("/api/admin/ledger/card-settlements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ depositAt: `${depositAt}:00+07:00`, amount: Number(amount), destinationAccountId: Number(accountId), memo }) }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      setAmount(""); setMemo(""); setCreateOpen(false); setMessage(t.created); await load();
    } catch (e) { setMessage(`${t.createFailed}: ${(e as Error).message}`); } finally { setWorking(false); }
  }
  const validFee = expectedFee.trim() !== "" && Number.isFinite(Number(expectedFee)) && Number(expectedFee) >= 0 && Number(expectedFee) < 100;
  function recommend(rec: Rec, sales = editableSales) {
    if (!validFee) { setMessage(t.invalidFee); return; }
    const plan = recommendCardAllocations(sales, Number(rec.deposit_amount), Number(expectedFee) / 100);
    setAllocations(Object.fromEntries(plan.allocations.map(row => [row.transactionId, String(row.allocatedGrossAmount)])));
    setMessage(plan.unallocatedGross > 0 ? `${t.recommendTarget} ${money(plan.targetGross)} · ${t.insufficientSales} ${money(plan.unallocatedGross)}. ${t.checkAllocation}` : `${t.recommendTarget} ${money(plan.targetGross)}. ${t.checkDifference}`);
  }
  async function open(rec: Rec) {
    const version = ++openVersion.current; setWorking(true); setSelected(null); setInspectedDeposit(null);
    try {
      const r = await fetch(`/api/admin/ledger/card-settlements/${rec.id}`, { cache: "no-store" }), b = await r.json();
      if (!r.ok) throw new Error(b.code);
      if (version !== openVersion.current) return;
      if (["matched", "cancelled"].includes(b.reconciliation.status)) throw new Error(t.invalidReconciliation);
      const lines: SavedLine[] = b.reconciliation.lines ?? [];
      const sales = eligibleCardSalesForDeposit(buildEditableCardSales(data?.sales ?? [], lines), rec.deposit_date);
      const eligibleSaleIds = new Set(sales.map(sale => sale.id));
      const eligibleLines = lines.filter(line => eligibleSaleIds.has(Number(line.pos_card_transaction_id)));
      setEditableSales(sales); setSelected(rec.id);
      if (eligibleLines.length) { setAllocations(Object.fromEntries(eligibleLines.map(line => [line.pos_card_transaction_id, String(line.allocated_gross_amount)]))); setMessage(t.savedLines); }
      else { setAllocations({}); recommend(rec, sales); }
    } catch (e) { setMessage(`${t.readFailed}: ${(e as Error).message}`); } finally { if (version === openVersion.current) setWorking(false); }
  }
  const rec = data?.reconciliations.find(row => row.id === selected);
  const invalidAllocation = Object.entries(allocations).some(([id, value]) => {
    if (value === "") return false;
    const numeric = Number(value), sale = editableSales.find(row => row.id === Number(id));
    return !Number.isFinite(numeric) || numeric < 0 || !sale || numeric > sale.outstandingGrossAmount || Math.abs(numeric - cardMoney(numeric)) > 0.0000001;
  });
  const gross = sumCardMoney(Object.values(allocations).filter(value => Number.isFinite(Number(value))));
  const difference = rec ? cardMoney(gross - Number(rec.deposit_amount)) : 0;
  const differenceRate = gross > 0 ? difference / gross : null;
  const inspectedGross=Number(inspectedDeposit?.matched_gross_amount);
  const inspectedDifference=Number(inspectedDeposit?.difference_amount);
  const inspectedFeeRate=inspectedGross>0&&Number.isFinite(inspectedGross)&&Number.isFinite(inspectedDifference)?(inspectedDifference/inspectedGross*100).toFixed(2):null;
  async function match(confirm: boolean) {
    if (!selected || !rec || invalidAllocation || gross <= 0 || (confirm && gross < Number(rec.deposit_amount))) return;
    setWorking(true);
    try {
      const rows = Object.entries(allocations).filter(([, value]) => Number(value) > 0).map(([transactionId, allocatedGrossAmount]) => ({ transactionId: Number(transactionId), allocatedGrossAmount: Number(allocatedGrossAmount) }));
      const r = await fetch(`/api/admin/ledger/card-settlements/${selected}/match`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allocations: rows, confirm }) }), b = await r.json();
      if (!r.ok) {
        if (b.code === "FUTURE_CARD_SALE") {
          const saleDate = b.result?.saleBusinessDate, depositDate = b.result?.depositDate;
          throw new Error(`${t.futureSale}${saleDate && depositDate ? ` (${t.saleDate} ${saleDate} · ${t.depositDate} ${depositDate})` : ""}`);
        }
        throw new Error(b.code);
      }
      setMessage(confirm ? `${t.completedDifference} ${money(Number(b.result.differenceAmount))}` : t.partialSaved);
      setSelected(null); setAllocations({}); setEditableSales([]); await load();
    } catch (e) { setMessage(`${t.matchFailed}: ${(e as Error).message}`); } finally { setWorking(false); }
  }
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
      setInspectedDeposit(null); setCancelOpen(false); setCancelReason("");
      await load();
    } catch (e) {
      setMessage(`${t.cancelFailed}: ${(e as Error).message}`);
    } finally {
      setWorking(false);
    }
  }
  const closeMatch=()=>{if(working)return;++openVersion.current;setSelected(null);setAllocations({});setEditableSales([]);setDrilldown(null);};
  return <Container noPaddingTop noPaddingBottom><main className={styles.page}>
    <header className={styles.header}><h1>{t.title}</h1></header>
    <section style={monthNoticeCardStyle} aria-label={t.selectMonth}><div style={monthControlStyle}>
      <button type="button" disabled={working} onClick={()=>shiftMonth(-1)} aria-label={t.previousMonth} style={monthButtonStyle}>{t.previous}</button>
      <input type="month" disabled={working} value={month} onChange={e=>selectMonth(e.target.value)} aria-label={t.selectMonth} style={monthInputStyle}/>
      <button type="button" disabled={working} onClick={()=>shiftMonth(1)} aria-label={t.nextMonth} style={monthButtonStyle}>{t.next}</button>
    </div></section>
    {message&&!rec&&!createOpen?<p role="status" className={styles.notice}>{message}</p>:null}
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
      <details className={styles.card}><summary className={styles.summary}><span>⏳ {t.unsettledSales}</span><strong>{money(data.summary.monthlyUnreconciledGross)}</strong><i aria-hidden="true">⌄</i></summary>
        <p className={styles.hint}>{t.statusHint}</p>
        <CardSalesList sales={data.monthlySales} onPos={openPos} empty={t.noMonthSales} text={t}/>
      </details>
      {data.priorUnreconciledSales.length?<details className={styles.card}><summary className={styles.summary}><span>↪️ {t.priorUnsettled}</span><strong>{money(sumCardMoney(data.priorUnreconciledSales.map(sale=>sale.outstandingGrossAmount)))}</strong><i aria-hidden="true">⌄</i></summary>
        <CardSalesList sales={data.priorUnreconciledSales} onPos={openPos} empty={t.noPriorSales} text={t}/>
      </details>:null}
      <button ref={createButtonRef} type="button" disabled={working} className={styles.primary} onClick={()=>{setMessage("");setCreateOpen(true);}}>＋ {t.registerDeposit}</button>
      <section className={styles.card} aria-label={lang==="vi"?"Theo tháng tiền thẻ về":"카드입금월 기준"}>
        <h2>🏦 {t.depositHistory}</h2>
        <div className={styles.depositTotals}><span>{t.deposit} {money(data.summary.actualCardDeposits)}</span><span>{t.difference} {money(data.summary.monthlyCompletedDifference)}</span><span>{t.averageFee} {data.summary.actualDifferenceRate == null ? "-" : `${(data.summary.actualDifferenceRate * 100).toFixed(2)}%`}</span></div>
        {data.reconciliations.length===0?<p className={styles.empty}>{t.noDeposits}</p>:<div className={styles.list}>{data.reconciliations.map(row=><article key={row.id} className={styles.depositRow}>
          <button type="button" disabled={working} className={styles.depositDetail} onClick={e=>{depositButtonRef.current=e.currentTarget;setCancelOpen(false);setCancelReason("");setInspectedDeposit(row);}}>
            <time dateTime={row.deposit_date}>{shortDate(row.deposit_date)}</time><strong>{money(Number(row.deposit_amount))}</strong><span className={styles.statusBadge+" "+(row.status==="matched"?styles.completedBadge:row.status==="cancelled"?styles.cancelledBadge:"")}>{statusName(row.status,t)}</span><i aria-hidden="true">›</i>
          </button>
          {["unmatched","partial"].includes(row.status)?<button type="button" disabled={working} className={styles.secondary} onClick={e=>{depositButtonRef.current=e.currentTarget;setMessage("");void open(row);}}>{t.matchSales}{row.status==="partial"?` ${t.edit}`:""}</button>:null}
        </article>)}</div>}
      </section>
      {createOpen?<BarSheet kind="full" compact title={t.registerDeposit} closeLabel={t.close} saving={working} onClose={()=>setCreateOpen(false)} returnFocusRef={createButtonRef} footer={<button form="card-deposit-form" type="submit" disabled={working} className={styles.primary} style={{...primaryButtonStyle,width:"100%"}}>{t.submitDeposit}</button>}>
        {message?<p role="status" className={styles.notice}>{message}</p>:null}
        <form id="card-deposit-form" onSubmit={create} className={styles.formGrid}>
          <BarField label={t.depositDate} required>{({id})=><input id={id} required type="datetime-local" disabled={working} value={depositAt} onChange={e=>setDepositAt(e.target.value)} style={keepingInputStyle}/>}</BarField>
          <BarField label={t.depositAmount} required>{({id})=><input id={id} required type="number" disabled={working} min="0.001" step="0.001" value={amount} onChange={e=>setAmount(e.target.value)} style={keepingInputStyle}/>}</BarField>
          <BarField label={t.depositAccount} required>{({id})=><select id={id} required disabled={working} value={accountId} onChange={e=>setAccountId(e.target.value)} style={keepingInputStyle}><option value="">{t.choose}</option>{data.accounts.filter(account=>account.code!=="card_clearing").map(account=><option key={account.id} value={account.id}>{account.display_name}</option>)}</select>}</BarField>
          <BarField label={t.memo}>{({id})=><input id={id} disabled={working} value={memo} onChange={e=>setMemo(e.target.value)} style={keepingInputStyle}/>}</BarField>
        </form>
      </BarSheet>:null}
      {inspectedDeposit?<BarSheet kind="full" compact title={`${inspectedDeposit.deposit_date} ${t.depositTitle}`} closeLabel={t.close} saving={working} onClose={()=>{setInspectedDeposit(null);setCancelOpen(false);setCancelReason("");}} returnFocusRef={depositButtonRef} footer={inspectedDeposit.status==="cancelled"?<button type="button" className={styles.secondary} onClick={()=>setInspectedDeposit(null)}>{t.close}</button>:cancelOpen?<div className={styles.actions}><button type="button" disabled={working} className={styles.secondary} onClick={()=>{setCancelOpen(false);setCancelReason("");}}>{t.back}</button><button type="button" disabled={working||!cancelReason.trim()} className={styles.danger} onClick={()=>void cancelReconciliation()}>{t.confirmCancel}</button></div>:<div className={styles.actions}><button type="button" disabled={working} className={styles.danger} onClick={()=>{setMessage("");setCancelOpen(true);}}>{t.cancelSettlement}</button>{["unmatched","partial"].includes(inspectedDeposit.status)?<button type="button" disabled={working} className={styles.primary} onClick={()=>{setMessage("");void open(inspectedDeposit);}}>{t.matchSales}{inspectedDeposit.status==="partial"?` ${t.edit}`:""}</button>:<button type="button" className={styles.secondary} onClick={()=>setInspectedDeposit(null)}>{t.close}</button>}</div>}>
        {message?<p role="status" className={styles.notice}>{message}</p>:null}
        <div className={styles.grid}><Card title={t.actualDeposit} value={money(Number(inspectedDeposit.deposit_amount))}/><Card title={t.settlementAmount} value={money(inspectedGross)}/><Card title={t.estimatedFee} value={`${money(inspectedDifference)}${inspectedFeeRate===null?"":` (${inspectedFeeRate}%)`}`}/><Card title={t.status} value={statusName(inspectedDeposit.status,t)}/></div>
        <p className={styles.hint}>{inspectedDeposit.destination?.display_name??"-"}</p>{inspectedDeposit.memo?<p className={styles.hint}>{inspectedDeposit.memo}</p>:null}
        {inspectedDeposit.status==="cancelled"?<div className={styles.cancelRecord}><strong>{t.cancelRecord}</strong><p>{inspectedDeposit.cancel_reason??t.noReason}</p><small>{inspectedDeposit.cancelled_at?new Date(inspectedDeposit.cancelled_at).toLocaleString(lang==="vi"?"vi-VN":"ko-KR",{timeZone:"Asia/Ho_Chi_Minh"}):"-"}</small></div>:null}
        {cancelOpen?<div className={styles.cancelPanel}>
          <p>{inspectedDeposit.status==="matched"?t.matchedCancelHint:t.partialCancelHint}</p>
          <label>{t.cancelReason}<textarea required disabled={working} value={cancelReason} onChange={e=>setCancelReason(e.target.value)} className={styles.input} rows={3}/></label>
        </div>:null}
      </BarSheet>:null}
      {rec?<BarSheet kind="full" compact topAligned fillAvailable title={`${shortDate(rec.deposit_date)} ${t.matchSales}`} closeLabel={t.close} saving={working} onClose={closeMatch} returnFocusRef={depositButtonRef} footer={<div className={styles.actions}><button type="button" disabled={working||invalidAllocation||gross<=0} className={styles.secondary} onClick={()=>void match(false)}>{t.savePartial}</button><button type="button" disabled={working||invalidAllocation||gross<=0||gross<Number(rec.deposit_amount)} className={styles.primary} onClick={()=>void match(true)}>{t.confirmSettlement}</button></div>}>
        <div className={styles.sheetBody}>
        {message?<p role="status" className={styles.notice}>{message}</p>:null}
        <div className={styles.grid} aria-label={t.confirmPreview}>
          <Card title={t.actualDeposit} value={money(Number(rec.deposit_amount))}/><Card title={t.settlementTarget} value={money(gross)}/>
          <Card title={t.settlementDifference} value={money(difference)}/><Card title={t.differenceRate} value={differenceRate===null?"-":(differenceRate*100).toFixed(3)+"%"}/>
        </div>
        <div className={styles.recommendation}>
          <label>{t.expectedFee}<input type="number" disabled={working} min="0" max="99.999" step="0.001" value={expectedFee} onChange={e=>setExpectedFee(e.target.value)} className={styles.input}/></label>
          <button type="button" disabled={working||!validFee} className={styles.secondary} onClick={()=>recommend(rec)}>{t.recommendOldest}</button>
        </div>
        <p className={styles.hint}>{t.recommendHint}</p>
        {invalidAllocation?<p role="alert" className={styles.validation}>{t.allocationValidation}</p>:null}
        {gross<Number(rec.deposit_amount)?<p className={styles.validation}>{t.partialOnly}</p>:null}
        {editableSales.length===0?<p className={styles.empty}>{t.noEligibleSales}</p>:null}
        <div className={styles.list}>{editableSales.map(sale=><article key={sale.id} className={styles.saleRow}>
          <div className={styles.saleHeading}><time dateTime={sale.business_date}>{shortDate(sale.business_date)}</time><button type="button" disabled={working} className={styles.secondary} onClick={()=>void openPos(sale.id)}>{t.posDetail}</button></div>
          <SaleGrossMetrics sale={sale} text={t}/>
          <label className={styles.allocationRow}><span>{t.allocation}</span><input aria-label={`${sale.business_date} ${t.allocation}`} type="number" disabled={working} min="0" max={sale.outstandingGrossAmount} step="0.001" value={allocations[sale.id]??""} onChange={e=>setAllocations(current=>({...current,[sale.id]:e.target.value}))} className={styles.input}/></label>
        </article>)}</div>
        </div>
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
function CardSalesList({sales,onPos,empty,text}:{sales:Sale[];onPos:(id:number)=>Promise<void>;empty:string;text:CardText}) {
  return <div className={styles.list}>{sales.length?sales.map(sale=><article key={sale.id} className={styles.saleRow}>
    <div className={styles.saleHeading}><time dateTime={sale.business_date}>{shortDate(sale.business_date)}</time><button type="button" className={styles.secondary} onClick={()=>void onPos(sale.id)}>{text.posDetail}</button></div>
    <SaleGrossMetrics sale={sale} text={text}/>
  </article>):<p className={styles.empty}>{empty}</p>}</div>;
}
function SaleGrossMetrics({sale,text}:{sale:Sale;text:CardText}) {
  return <dl className={styles.saleMetrics}><div><dt>{text.cardSales}</dt><dd>{money(Number(sale.amount))}</dd></div><div><dt title={text.allocatedHint}>{text.saleAllocated}</dt><dd>{money(sale.allocatedGrossAmount)}</dd></div><div><dt>{text.saleRemaining}</dt><dd>{money(sale.outstandingGrossAmount)}</dd></div></dl>;
}
