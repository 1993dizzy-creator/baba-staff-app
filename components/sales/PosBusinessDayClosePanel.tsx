'use client';
import { useCallback,useEffect,useState,type CSSProperties } from 'react';
import { useLanguage } from '@/lib/language-context';
import { salesCloseText } from '@/lib/text/sales-close';
import { ui } from '@/lib/styles/ui';
import type { PosCloseView } from '@/lib/sales/pos-business-day-close-view';
import type { PosCloseTotals } from '@/lib/sales/pos-business-day-final-policy';
const buckets=['cash','transfer','card','other'] as const;
const money=(amount:number)=>new Intl.NumberFormat('vi-VN',{style:'currency',currency:'VND',maximumFractionDigits:0}).format(amount);
const signed=(amount:number)=>(amount>0?'+':'')+money(amount);
export default function PosBusinessDayClosePanel({businessDate,refreshKey,onClosed,onBusyChange,disabled=false}:{businessDate:string;refreshKey:number;onClosed:()=>Promise<void>;onBusyChange:(busy:boolean)=>void;disabled?:boolean}){
 const {lang}=useLanguage(),t=salesCloseText[lang];
 const [status,setStatus]=useState<PosCloseView|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [message,setMessage]=useState(''),[confirm,setConfirm]=useState(false);
 const load=useCallback(async(signal?:AbortSignal,clearMessage=false)=>{
  if(clearMessage)setMessage('');
  try{
   const response=await fetch('/api/admin/sales/close-status?businessDate='+encodeURIComponent(businessDate),{cache:'no-store',signal});
   const result=await response.json();if(!response.ok||!result.ok)throw Error('status_failed');
   if(!signal?.aborted)setStatus(result);
  }catch{if(!signal?.aborted)setStatus(null);}
  finally{if(!signal?.aborted)setLoading(false);}
 },[businessDate]);
 useEffect(()=>{const controller=new AbortController();void load(controller.signal,true);return()=>controller.abort();},[load,refreshKey]);
 const errorText=(code:string)=>({card_settlement_locked:t.cardLocked,month_closed:t.monthClosed,forbidden:t.forbidden,
  source_changed_after_close:t.sourceChanged,POS_CLOSE_SOURCE_CHANGED_SINCE_REVIEW:t.sourceChanged,
  POS_CLOSE_BEFORE_CONFIGURED_CLOSE_TIME:t.beforeClose,POS_CLOSE_SYNC_FAILED:t.syncFailed,POS_CLOSE_SOURCE_INVALID:t.sourceInvalid,
  POS_CLOSE_FORBIDDEN:t.forbidden,RELOGIN_REQUIRED:t.relogin} as Record<string,string>)[code]??t.failed;
 async function close(reclose:boolean){
  if(busy||disabled)return;
  setBusy(true);onBusyChange(true);setMessage('');
  try{
   const response=await fetch('/api/admin/sales/close',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({businessDate,reclose,...(reclose?{expectedSourceFingerprint:status?.currentFingerprint}:{})})});
   const result=await response.json();
   setMessage(response.ok&&result.ok?(result.status==='already_closed'?'unchanged':'done'):(result.code??result.status));
   setConfirm(false);await Promise.all([load(),onClosed()]);
  }catch{setMessage('POS_CLOSE_FAILED');}finally{setBusy(false);onBusyChange(false);}
 }
 const totals=status?.latestClose?.totals??status?.currentTotals;
 const check=status?.latestFinalCheck;
 const reason=status?.closeEligibilityReason;
 const eligibility=reason==='source_invalid'?t.sourceInvalid:reason==='month_closed'?t.monthClosed:reason==='future_business_date'?t.future
  :reason==='configured_close_time_unavailable'?t.settings:reason==='configured_close_time'?t.beforeClose:reason==='forbidden'?t.forbidden:'';
 const stamp=(value:string)=>new Intl.DateTimeFormat(lang==='ko'?'ko-KR':'vi-VN',{timeZone:'Asia/Ho_Chi_Minh',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
 function deltaRows(delta:PosCloseTotals){return <div style={grid}>{buckets.map(bucket=><div key={bucket}><span>{t[bucket]}</span><strong style={amount}>{signed(Number(delta[bucket]))}</strong></div>)}</div>;}
 return <section style={card} aria-busy={busy||loading}>
  <h2 style={{margin:'0 0 12px',fontSize:17}}>{status?.latestClose?t.closed:t.title}</h2>
  {loading?<p>{t.loading}</p>:!status?<p role='alert'>{t.failed}</p>:<>
   <strong style={{fontSize:25}}>{totals?money(totals.total):t.notAvailable}</strong>
   {status.latestClose?<p style={muted}>{status.latestClose.method==='automatic'?t.automatic:t.manual} · {stamp(status.latestClose.closedAt)} · {status.latestClose.method==='automatic'?t.system:status.latestClose.closedBy}</p>:null}
   {totals?<div style={grid}>{buckets.map(bucket=><div key={bucket}><span>{t[bucket]}</span><strong style={amount}>{money(totals[bucket])}</strong></div>)}</div>:null}
   <p style={muted}>{t.lastSync}: {status.finalSync.lastSyncedAt?stamp(status.finalSync.lastSyncedAt):t.notAvailable}</p>
   {status.latestClose&&!status.sourceValid?<p role='alert'>{t.sourceInvalid}</p>:null}
   {status.latestClose&&status.monthClosed?<p style={muted}>{t.monthClosed}</p>:null}
   {status.latestClose?<div style={{...notice,background:check?.result==='financial_drift'?'#fff7ed':check?.result==='verified_unchanged'?'#f0fdf4':'#f3f4f6'}}>
    {!check?<p>{t.pending}</p>:<>
     <strong>{check.result==='verified_unchanged'?t.verified:check.result==='metadata_changed_only'?t.metadata:check.result==='financial_drift'?t.drift:t.checkFailed}</strong>
     <p style={muted}>{stamp(check.checkedAt)}</p>
     {check.result==='verified_unchanged'?<p>{t.verifiedDetail}</p>:check.result==='metadata_changed_only'?<p>{t.metadataDetail}</p>:check.result==='financial_drift'?<>
      <p>{t.closedTotal}: {money(check.closedTotal??0)}<br/>{t.finalTotal}: {money(check.currentTotal??0)}<br/><strong>{t.difference}: {signed(check.totalDelta??0)}</strong></p>
      {check.bucketDelta?deltaRows({total:check.totalDelta??0,...check.bucketDelta}):null}
     </>:<p>{check.result==='sync_failed'?t.syncFailed:check.result==='month_closed'?t.monthClosed:t.sourceInvalid}</p>}
    </>}
   </div>:check?<p role='status'>{t.checkFailed} ? {check.result==='sync_failed'?t.syncFailed:check.result==='month_closed'?t.monthClosed:t.sourceInvalid}</p>:null}
   {status.ledgerProjection.status==='mismatch'?<p role='alert'>{t.ledgerMismatch}</p>:null}
   {!status.latestClose?<>
    {eligibility?<p style={muted}>{eligibility}</p>:null}
    <button style={{...ui.button,opacity:status.canClose&&!busy&&!disabled?1:0.5}} disabled={!status.canClose||busy||disabled} onClick={()=>void close(false)}>{busy?t.working:t.close}</button>
   </>:status.canReclose?<>
    {status.drift&&status.delta&&Object.values(status.delta).some(amount=>amount!==0)&&check?.result!=='financial_drift'?<p>{t.drift}</p>:null}
    <button style={ui.button} disabled={busy||disabled} onClick={()=>setConfirm(true)}>{busy?t.working:t.recloseReview}</button>
   </>:status.needsOwnerReview?<p>{t.ownerReview}</p>:null}
   {confirm&&status.latestClose&&status.currentTotals&&status.delta?<div role='region' aria-label={t.recloseReview} style={notice}>
    <p>{t.confirm}</p><p>{t.closedTotal}: {money(status.latestClose.totals.total)}<br/>{t.current}: {money(status.currentTotals.total)}<br/><strong>{t.difference}: {signed(status.delta.total)}</strong></p>
    {deltaRows(status.delta)}<div style={{display:'flex',gap:8,marginTop:12}}>
     <button style={ui.subButton} disabled={busy} onClick={()=>setConfirm(false)}>{t.cancel}</button>
     <button style={ui.button} disabled={busy||disabled} onClick={()=>void close(true)}>{busy?t.working:t.reclose}</button>
    </div>
   </div>:null}
  </>}
  {message?<p role='status' style={{fontSize:13,lineHeight:1.5}}>{message==='done'?t.done:message==='unchanged'?t.unchanged:errorText(message)}</p>:null}
 </section>;
}
const card:CSSProperties={background:'#fff',border:'1px solid #e5e7eb',borderRadius:18,padding:16};
const grid:CSSProperties={display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:12,margin:'14px 0',fontSize:13};
const amount:CSSProperties={display:'block',marginTop:4,overflowWrap:'anywhere'};
const muted:CSSProperties={fontSize:12,color:'#6b7280',lineHeight:1.5};
const notice:CSSProperties={borderRadius:12,padding:12,margin:'12px 0',fontSize:13,lineHeight:1.5,background:'#f3f4f6'};
