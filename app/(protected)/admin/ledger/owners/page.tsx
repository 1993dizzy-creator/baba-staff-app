"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Container from "@/components/Container";
import { BarSheet } from "@/components/bar/keeping/KeepingUi";
import { getBusinessDate } from "@/lib/common/business-time";
import { allocateOwnerPool } from "@/lib/ledger/owner-allocation-core";
import styles from "./owners.module.css";

type Owner = { participantId:number; userId:number; name:string; sortOrder:number; cumulativeInvested:number; recoveryAllocated:number; recoveryPaid:number; cashUnrecovered:number; pureProfitAllocated:number; pureProfitPaid:number; unpaidSettlement:number };
type Account = { id:number; display_name:string };
type Allocation = { id:number; participant_id:number; rate_snapshot:string; assigned_amount:number; paid_amount:number };
type Settlement = { id:number; through_month:string; status:string; confirmed_pool:number; allocations:Allocation[] };
type Dashboard = { capacity:{recommendedMax?:number;undistributedProfit?:number;liquidFunds?:number;activeReserve?:number;vendorPayables?:number;confirmedUnpaidOwnerSettlements?:number;safeCashCapacity?:number}; owners:Owner[]; accounts:Account[]; settlements:Settlement[]; closedMonths:string[]; policy:{lines:Array<{participant_id:number;settlement_rate:string}>}|null; participantUser:Record<string,number> };
type Sheet = "owner"|"investment"|"settlement"|"recent"|null;
type InvestmentType = "opening"|"contribution"|"adjustment";

const currentMonth=()=>getBusinessDate().slice(0,7);
const money=(value:unknown)=>`${new Intl.NumberFormat("vi-VN",{maximumFractionDigits:3}).format(Number(value??0))} ₫`;
const percent=(value:unknown)=>`${new Intl.NumberFormat("ko-KR",{maximumFractionDigits:2}).format(Number(value??0)*100)}%`;
const monthLabel=(value:string)=>`${value.slice(0,4)}년 ${Number(value.slice(5,7))}월`;
const localDateTime=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Ho_Chi_Minh",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date()).replace(" ","T");
const timestamp=(value:string)=>`${value}:00+07:00`;
const validAmount=(value:string,signed=false)=>(signed?/^-?\d+(?:\.\d{1,3})?$/:/^\d+(?:\.\d{1,3})?$/).test(value)&&Number(value)!==0;
async function readDashboard(month:string,investmentView:"current"|"month_end",signal?:AbortSignal):Promise<Dashboard>{
  const response=await fetch(`/api/admin/ledger/owners?throughMonth=${month}&investmentView=${investmentView}`,{cache:"no-store",signal});
  const body=await response.json();
  if(!response.ok)throw new Error(body.code??"OWNER_DASHBOARD_LOAD_FAILED");
  return body as Dashboard;
}
function Figure({label,value}:{label:string;value:unknown}){return <div className={styles.figure}><span>{label}</span><strong>{money(value)}</strong></div>}

export default function OwnerSettlementsPage(){
  const[currentData,setCurrentData]=useState<Dashboard|null>(null);
  const[settlementData,setSettlementData]=useState<{month:string;data:Dashboard}|null>(null);
  const[settlementMonth,setSettlementMonth]=useState("");
  const[sheet,setSheet]=useState<Sheet>(null);
  const[ownerId,setOwnerId]=useState<number|null>(null);
  const[settlementId,setSettlementId]=useState<number|null>(null);
  const[paymentAllocationId,setPaymentAllocationId]=useState<number|null>(null);
  const[investment,setInvestment]=useState<{participantId:string;entryType:InvestmentType;amount:string;occurredAt:string;accountId:string;reason:string}>({participantId:"",entryType:"opening",amount:"",occurredAt:localDateTime(),accountId:"",reason:""});
  const[pool,setPool]=useState("");
  const[payment,setPayment]=useState({amount:"",accountId:"",paidAt:localDateTime(),memo:""});
  const[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[formError,setFormError]=useState("");

  const loadCurrent=useCallback(async(signal?:AbortSignal)=>{
    try{const result=await readDashboard(currentMonth(),"current",signal);if(!signal?.aborted)setCurrentData(result)}
    catch(error){if(!signal?.aborted)setMessage(error instanceof Error?error.message:"현황을 불러오지 못했습니다.")}
  },[]);
  useEffect(()=>{const controller=new AbortController();void loadCurrent(controller.signal);return()=>controller.abort()},[loadCurrent]);
  useEffect(()=>{
    if(sheet!=="settlement"||!settlementMonth)return;
    const controller=new AbortController();
    void readDashboard(settlementMonth,"month_end",controller.signal).then(data=>{if(!controller.signal.aborted)setSettlementData({month:settlementMonth,data})}).catch(error=>{if(!controller.signal.aborted)setFormError(error instanceof Error?error.message:"정산 자료를 불러오지 못했습니다.")});
    return()=>controller.abort();
  },[sheet,settlementMonth]);
  async function mutate(payload:Record<string,unknown>){
    setBusy(true);setFormError("");
    try{
      const response=await fetch("/api/admin/ledger/owners",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      const body=await response.json();
      if(!response.ok)throw new Error(body.code??"저장하지 못했습니다.");
      await loadCurrent();setMessage("저장되었습니다.");return true;
    }catch(error){setFormError(error instanceof Error?error.message:"저장하지 못했습니다.");return false}
    finally{setBusy(false)}
  }
  function closeSheet(){if(!busy){setSheet(null);setPaymentAllocationId(null);setFormError("")}}
  function openInvestment(){setInvestment({participantId:"",entryType:"opening",amount:"",occurredAt:localDateTime(),accountId:"",reason:""});setFormError("");setSheet("investment")}
  function openSettlement(){setSettlementMonth(currentData?.closedMonths[0]??"");setSettlementData(null);setPool("");setFormError("");setSheet("settlement")}
  function openRecent(id:number){setSettlementId(id);setPaymentAllocationId(null);setFormError("");setSheet("recent")}
  async function saveInvestment(){if(await mutate({action:"investment",participantId:Number(investment.participantId),entryType:investment.entryType,amount:investment.amount,occurredAt:timestamp(investment.occurredAt),fundAccountId:investment.entryType==="contribution"?Number(investment.accountId):null,reason:investment.reason.trim()||null}))closeSheet()}
  async function confirmSettlement(){if(await mutate({action:"confirm",throughMonth:`${settlementMonth}-01`,requestedPool:pool}))closeSheet()}
  async function savePayment(){if(await mutate({action:"pay",allocationId:paymentAllocationId,amount:payment.amount,fundAccountId:Number(payment.accountId),paidAt:timestamp(payment.paidAt),memo:payment.memo.trim()||null}))setPaymentAllocationId(null)}

  const owners=currentData?.owners??[];
  const recentSettlements=(currentData?.settlements??[]).filter(row=>row.status!=="draft").slice(0,5);
  const totals={invested:owners.reduce((sum,owner)=>sum+Number(owner.cumulativeInvested),0),recovered:owners.reduce((sum,owner)=>sum+Number(owner.recoveryPaid),0),unrecovered:owners.reduce((sum,owner)=>sum+Number(owner.cashUnrecovered),0)};
  const selectedOwner=owners.find(owner=>owner.participantId===ownerId);
  const selectedSettlement=currentData?.settlements.find(row=>row.id===settlementId);
  const selectedAllocation=selectedSettlement?.allocations.find(row=>row.id===paymentAllocationId);
  const historical=settlementData?.month===settlementMonth?settlementData.data:null;
  const recommendedMax=Number(historical?.capacity?.recommendedMax??0);
  const canConfirm=!!historical?.policy&&!!historical.closedMonths.includes(settlementMonth)&&validAmount(pool)&&Number(pool)>0&&Number(pool)<=recommendedMax&&!busy;
  const preview=useMemo(()=>{
    if(!historical?.policy||!validAmount(pool)||Number(pool)<=0)return [];
    return allocateOwnerPool(pool,historical.policy.lines.map(line=>({participantId:Number(line.participant_id),rate:line.settlement_rate,sortOrder:historical.owners.find(owner=>owner.participantId===Number(line.participant_id))?.sortOrder??0})));
  },[historical,pool]);
  const ownerName=(id:number)=>{const userId=currentData?.participantUser[String(id)];return owners.find(owner=>owner.userId===userId)?.name??"사장"};
  const canInvest=!!investment.participantId&&!!investment.occurredAt&&validAmount(investment.amount,investment.entryType==="adjustment")&&(investment.entryType!=="contribution"||!!investment.accountId)&&(investment.entryType!=="adjustment"||!!investment.reason.trim())&&!busy;
  const paymentRemaining=selectedAllocation?Math.round((Number(selectedAllocation.assigned_amount)-Number(selectedAllocation.paid_amount))*1000)/1000:0;
  const canPay=!!selectedAllocation&&validAmount(payment.amount)&&Number(payment.amount)>0&&Number(payment.amount)<=paymentRemaining&&!!payment.accountId&&!!payment.paidAt&&!busy;

  return <Container noPaddingTop><main className={styles.page}>
    <header className={styles.header}><Link href="/admin/ledger" className={styles.back} aria-label="장부로 돌아가기"><span aria-hidden="true">←</span></Link><h1>투자금 · 사장정산</h1></header>
    {message?<p className={styles.notice} role="status">{message}</p>:null}
    <section className={styles.summary} aria-label="투자금 요약"><Figure label="총 투자금" value={totals.invested}/><Figure label="회수 완료" value={totals.recovered}/><Figure label="미회수 투자금" value={totals.unrecovered}/></section>
    <section className={styles.section}><h2>사장별 현황</h2>{owners.length?<div className={styles.ownerList}>{owners.map(owner=>{
      const rate=currentData?.policy?.lines.find(line=>Number(line.participant_id)===owner.participantId)?.settlement_rate;
      return <button type="button" className={styles.ownerCard} key={owner.participantId} onClick={()=>{setOwnerId(owner.participantId);setSheet("owner")}}><span className={styles.ownerName}>{owner.name}<i aria-hidden>›</i></span><span>누적 투자금 <b>{money(owner.cumulativeInvested)}</b></span><span>회수 완료 <b>{money(owner.recoveryPaid)}</b></span><span>미회수 <b>{money(owner.cashUnrecovered)}</b></span><span>정산 비율 <b>{rate?percent(rate):"-"}</b></span></button>})}</div>:<p className={styles.empty}>설정된 정산 참여자가 없습니다.</p>}</section>
    <div className={styles.actions}><button type="button" className={styles.primary} onClick={openInvestment} disabled={!owners.length}>+ 투자금 등록</button><button type="button" className={styles.secondary} onClick={openSettlement} disabled={!currentData?.closedMonths.length}>사장 정산</button></div>
    <p className={styles.settingsHint}>참여자와 정산 비율은 <Link href="/admin/ledger/settings">장부설정</Link>에서 관리합니다.</p>
    <section className={styles.section}><h2>최근 정산 내역</h2>{recentSettlements.length?<div className={styles.recentList}>{recentSettlements.map(row=>{
      const paid=row.allocations.reduce((sum,item)=>sum+Number(item.paid_amount),0);
      return <button type="button" key={row.id} onClick={()=>openRecent(row.id)}><span><strong>{monthLabel(String(row.through_month).slice(0,7))} 정산</strong><small>확정 {money(row.confirmed_pool)} · 미지급 {money(Math.max(0,Number(row.confirmed_pool)-paid))}</small></span><i aria-hidden>›</i></button>})}</div>:<p className={styles.empty}>확정된 정산 내역이 없습니다.</p>}</section>

    {sheet==="owner"&&selectedOwner?<BarSheet kind="bottom" title={`${selectedOwner.name} 현황`} closeLabel="닫기" onClose={closeSheet} footer={<button className={styles.secondary} type="button" onClick={closeSheet}>닫기</button>}><div className={styles.sheetFigures}><Figure label="누적 투자금" value={selectedOwner.cumulativeInvested}/><Figure label="회수 배정" value={selectedOwner.recoveryAllocated}/><Figure label="실제 회수" value={selectedOwner.recoveryPaid}/><Figure label="미회수 투자금" value={selectedOwner.cashUnrecovered}/><Figure label="순이익 배정" value={selectedOwner.pureProfitAllocated}/><Figure label="순이익 지급" value={selectedOwner.pureProfitPaid}/><Figure label="현재 정산 미지급" value={selectedOwner.unpaidSettlement}/><div className={styles.figure}><span>정산 비율</span><strong>{percent(currentData?.policy?.lines.find(line=>Number(line.participant_id)===selectedOwner.participantId)?.settlement_rate)}</strong></div></div></BarSheet>:null}

    {sheet==="investment"?<BarSheet kind="bottom" title="투자금 등록" closeLabel="닫기" saving={busy} onClose={closeSheet} footer={<button className={styles.primary} type="button" disabled={!canInvest} onClick={()=>void saveInvestment()}>투자금 저장</button>}><div className={styles.form}>
      <label>사장<select className={styles.input} value={investment.participantId} onChange={event=>setInvestment({...investment,participantId:event.target.value})}><option value="">선택</option>{owners.map(owner=><option key={owner.participantId} value={owner.participantId}>{owner.name}</option>)}</select></label>
      <label>유형<select className={styles.input} value={investment.entryType} onChange={event=>setInvestment({...investment,entryType:event.target.value as InvestmentType,accountId:""})}><option value="opening">초기 투자금</option><option value="contribution">추가 투자</option><option value="adjustment">투자금 조정</option></select></label>
      <label>금액<input className={styles.input} inputMode="decimal" value={investment.amount} onChange={event=>setInvestment({...investment,amount:event.target.value})} placeholder={investment.entryType==="adjustment"?"+ 또는 - 금액":"금액"}/></label>
      <label>날짜/시간<input className={styles.input} type="datetime-local" value={investment.occurredAt} onChange={event=>setInvestment({...investment,occurredAt:event.target.value})}/></label>
      {investment.entryType==="contribution"?<label>입금계좌<select className={styles.input} value={investment.accountId} onChange={event=>setInvestment({...investment,accountId:event.target.value})}><option value="">선택</option>{currentData?.accounts.map(account=><option key={account.id} value={account.id}>{account.display_name}</option>)}</select></label>:null}
      <label>메모/사유<input className={styles.input} value={investment.reason} onChange={event=>setInvestment({...investment,reason:event.target.value})} placeholder={investment.entryType==="adjustment"?"조정 사유 필수":"선택 입력"}/></label>{formError?<p role="alert" className={styles.error}>{formError}</p>:null}
    </div></BarSheet>:null}

    {sheet==="settlement"?<BarSheet kind="bottom" topAligned comfortableTop title="사장 정산" closeLabel="닫기" saving={busy} onClose={closeSheet} footer={<button className={styles.primary} type="button" disabled={!canConfirm} onClick={()=>void confirmSettlement()}>정산 확정</button>}><div className={styles.form}>
      <label>정산 기준 마감월<select className={styles.input} value={settlementMonth} onChange={event=>{setSettlementMonth(event.target.value);setSettlementData(null);setPool("");setFormError("")}}>{currentData?.closedMonths.map(month=><option key={month} value={month}>{monthLabel(month)}</option>)}</select></label>
      {historical?<><Figure label="정산 가능 최대" value={recommendedMax}/><label>정산할 금액<input className={styles.input} inputMode="decimal" value={pool} onChange={event=>setPool(event.target.value)} placeholder="금액 입력"/></label>
        {preview.length?<div className={styles.preview}><h3>사장별 예상 배분</h3>{preview.map(line=><div key={line.participantId}><span>{historical.owners.find(owner=>owner.participantId===line.participantId)?.name??"사장"} <small>{percent(line.rate)}</small></span><strong>{money(line.assignedAmount)}</strong></div>)}</div>:null}
        <details className={styles.capacity}><summary>정산 가능액 계산 상세</summary><div><Figure label="미분배이익" value={historical.capacity.undistributedProfit}/><Figure label="현금성 자금" value={historical.capacity.liquidFunds}/><Figure label="준비금" value={historical.capacity.activeReserve}/><Figure label="거래처 미지급" value={historical.capacity.vendorPayables}/><Figure label="사장 확정 미지급" value={historical.capacity.confirmedUnpaidOwnerSettlements}/><Figure label="안전 현금" value={historical.capacity.safeCashCapacity}/></div></details>
        {!historical.policy?<p className={styles.empty}>정산 비율을 장부설정에서 먼저 등록해주세요.</p>:null}
      </>:<p className={styles.empty}>마감월 정산 자료를 불러오는 중입니다.</p>}{formError?<p role="alert" className={styles.error}>{formError}</p>:null}
    </div></BarSheet>:null}

    {sheet==="recent"&&selectedSettlement?<BarSheet kind="bottom" title={`${monthLabel(String(selectedSettlement.through_month).slice(0,7))} 정산`} closeLabel="닫기" saving={busy} onClose={closeSheet} footer={<button className={styles.secondary} type="button" onClick={closeSheet}>닫기</button>}><div className={styles.form}><Figure label="확정 금액" value={selectedSettlement.confirmed_pool}/>
      {selectedSettlement.allocations.map(allocation=>{const remaining=Math.max(0,Math.round((Number(allocation.assigned_amount)-Number(allocation.paid_amount))*1000)/1000);return <section className={styles.allocation} key={allocation.id}><h3>{ownerName(allocation.participant_id)} <small>{percent(allocation.rate_snapshot)}</small></h3><div><span>배정</span><b>{money(allocation.assigned_amount)}</b></div><div><span>지급</span><b>{money(allocation.paid_amount)}</b></div><div><span>미지급</span><b>{money(remaining)}</b></div>
        {remaining>0&&paymentAllocationId!==allocation.id?<button className={styles.secondary} type="button" onClick={()=>{setPaymentAllocationId(allocation.id);setPayment({amount:String(remaining),accountId:"",paidAt:localDateTime(),memo:""});setFormError("")}}>지급 등록</button>:null}
        {paymentAllocationId===allocation.id?<div className={styles.form}><label>지급액<input className={styles.input} inputMode="decimal" value={payment.amount} onChange={event=>setPayment({...payment,amount:event.target.value})}/></label><label>지급계좌<select className={styles.input} value={payment.accountId} onChange={event=>setPayment({...payment,accountId:event.target.value})}><option value="">선택</option>{currentData?.accounts.map(account=><option key={account.id} value={account.id}>{account.display_name}</option>)}</select></label><label>지급일시<input className={styles.input} type="datetime-local" value={payment.paidAt} onChange={event=>setPayment({...payment,paidAt:event.target.value})}/></label><label>메모<input className={styles.input} value={payment.memo} onChange={event=>setPayment({...payment,memo:event.target.value})}/></label><button className={styles.primary} type="button" disabled={!canPay} onClick={()=>void savePayment()}>지급 저장</button></div>:null}
      </section>})}{formError?<p role="alert" className={styles.error}>{formError}</p>:null}
    </div></BarSheet>:null}
  </main></Container>;
}
