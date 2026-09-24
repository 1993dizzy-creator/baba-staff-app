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
 const [message,setMessage]=useState(''),[confirm,setConfirm]=useState(false),[confirmInitialClose,setConfirmInitialClose]=useState(false);
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
   setConfirm(false);setConfirmInitialClose(false);await Promise.all([load(),onClosed()]);
  }catch{setMessage('POS_CLOSE_FAILED');}finally{setBusy(false);onBusyChange(false);}
 }
 const check=status?.latestFinalCheck;
 const reason=status?.closeEligibilityReason;
 const eligibility=reason==='source_invalid'?t.sourceInvalid:reason==='month_closed'?t.monthClosed:reason==='future_business_date'?t.future
  :reason==='configured_close_time_unavailable'?t.settings:['configured_close_time','manual_close_time'].includes(reason??'')?t.beforeClose:reason==='forbidden'?t.forbidden:'';
 const stamp=(value:string)=>new Intl.DateTimeFormat(lang==='ko'?'ko-KR':'vi-VN',{timeZone:'Asia/Ho_Chi_Minh',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
 function deltaRows(delta:PosCloseTotals){return <div style={grid}>{buckets.map(bucket=><div key={bucket}><span>{t[bucket]}</span><strong style={amount}>{signed(Number(delta[bucket]))}</strong></div>)}</div>;}
 const closeMeta=status?.latestClose
  ? `${status.latestClose.method==='automatic'?t.automatic:t.manual} · ${status.latestClose.method==='automatic'?'':`${status.latestClose.closedBy} · `}${stamp(status.latestClose.closedAt)}`
  : '';
 const checkDetail=!status?.latestClose?'':!check?t.pending:check.result==='verified_unchanged'?''
  :check.result==='metadata_changed_only'?`${t.metadata} · ${t.metadataDetail}`
  :check.result==='financial_drift'?`${t.drift} · ${t.difference}: ${signed(check.totalDelta??0)}`
  :`${t.checkFailed} · ${check.result==='sync_failed'?t.syncFailed:check.result==='month_closed'?t.monthClosed:t.sourceInvalid}`;
 return <div style={compact} aria-busy={busy||loading}>
  {loading?<p style={muted}>{t.loading}</p>:!status?<p role='alert' style={warning}>{t.failed}</p>:<>
   {!status.latestClose?<>
    <button style={{...closeButton,opacity:status.canClose&&!busy&&!disabled?1:0.5}} disabled={!status.canClose||busy||disabled} onClick={()=>setConfirmInitialClose(true)}>{busy?t.working:t.close}</button>
    {eligibility?<p style={muted}>{eligibility}</p>:null}
   </>:status.canReclose?
    <button style={closeButton} disabled={busy||disabled} onClick={()=>setConfirm(true)}>{busy?t.working:t.recloseReview}</button>
    :<div role='status' style={closedStatus}>✓ {t.closed}</div>}
   {closeMeta?<p style={muted}>{closeMeta}</p>:null}
   {checkDetail?<p role={check?.result==='metadata_changed_only'?'status':'alert'} style={check?.result==='metadata_changed_only'?info:warning}>{checkDetail}</p>:null}
   {status.latestClose&&!status.sourceValid&&check?.result!=='source_invalid'?<p role='alert' style={warning}>{t.sourceInvalid}</p>:null}
   {status.latestClose&&status.monthClosed&&check?.result!=='month_closed'?<p role='alert' style={warning}>{t.monthClosed}</p>:null}
   {status.ledgerProjection.status==='mismatch'?<p role='alert' style={warning}>{t.ledgerMismatch}</p>:null}
   {status.needsOwnerReview?<p role='alert' style={warning}>{t.ownerReview}</p>:null}
   {status.drift&&status.delta&&Object.values(status.delta).some(value=>value!==0)&&check?.result!=='financial_drift'?<p role='alert' style={warning}>{t.drift}</p>:null}
   {confirmInitialClose&&!status.latestClose?<div role='dialog' aria-modal='true' aria-label={t.manualCloseConfirmTitle} style={notice}>
    <strong>{t.manualCloseConfirmTitle}</strong><p style={{margin:'6px 0 0'}}>{t.manualCloseConfirmDetail}</p>
    <div style={{display:'flex',gap:8,marginTop:12}}>
     <button style={ui.subButton} disabled={busy} onClick={()=>setConfirmInitialClose(false)}>{t.cancel}</button>
     <button style={ui.button} disabled={busy||disabled} onClick={()=>void close(false)}>{busy?t.working:t.proceedClose}</button>
    </div>
   </div>:null}
   {confirm&&status.latestClose&&status.currentTotals&&status.delta?<div role='region' aria-label={t.recloseReview} style={notice}>
    <p>{t.confirm}</p><p>{t.closedTotal}: {money(status.latestClose.totals.total)}<br/>{t.current}: {money(status.currentTotals.total)}<br/><strong>{t.difference}: {signed(status.delta.total)}</strong></p>
    {deltaRows(status.delta)}<div style={{display:'flex',gap:8,marginTop:12}}>
     <button style={ui.subButton} disabled={busy} onClick={()=>setConfirm(false)}>{t.cancel}</button>
     <button style={ui.button} disabled={busy||disabled} onClick={()=>void close(true)}>{busy?t.working:t.reclose}</button>
    </div>
   </div>:null}
  </>}
  {message?<p role='status' style={messageStyle}>{message==='done'?t.done:message==='unchanged'?t.unchanged:errorText(message)}</p>:null}
 </div>;
}
const compact:CSSProperties={display:'grid',gap:6,minWidth:0};
const closeButton:CSSProperties={...ui.subButton,width:'100%',minHeight:40,padding:'9px 12px',fontSize:13,fontWeight:800,borderRadius:10};
const closedStatus:CSSProperties={minHeight:40,display:'flex',alignItems:'center',justifyContent:'center',padding:'9px 12px',border:'1px solid #d1d5db',borderRadius:10,background:'#fff',color:'#166534',fontSize:13,fontWeight:800};
const grid:CSSProperties={display:'grid',gridTemplateColumns:'repeat(2,minmax(0,1fr))',gap:12,margin:'14px 0',fontSize:13};
const amount:CSSProperties={display:'block',marginTop:4,overflowWrap:'anywhere'};
const muted:CSSProperties={margin:0,fontSize:11,color:'#6b7280',lineHeight:1.45,overflowWrap:'anywhere'};
const warning:CSSProperties={margin:0,border:'1px solid #fde68a',borderRadius:8,padding:'7px 8px',background:'#fffbeb',color:'#92400e',fontSize:12,fontWeight:700,lineHeight:1.45,overflowWrap:'anywhere'};
const info:CSSProperties={...warning,border:'1px solid #d1d5db',background:'#f9fafb',color:'#4b5563'};
const messageStyle:CSSProperties={margin:0,fontSize:12,lineHeight:1.45,overflowWrap:'anywhere'};
const notice:CSSProperties={borderRadius:12,padding:12,margin:'12px 0',fontSize:13,lineHeight:1.5,background:'#f3f4f6'};
