import 'server-only';
import { getAuthenticatedActor } from '@/lib/auth/server-auth';
import { supabaseServer } from '@/lib/supabase/server';
import { loadPosBusinessDaySource } from '@/lib/ledger/pos-sales';
import { closePosBusinessDay,getPosBusinessDayCloseTime,resolvePosCloseSystemActor } from './pos-business-day-close';
import { runManualCloseWorkflow,runPosFinalWorkflow } from './pos-business-day-final-workflow';
import { forceRefreshPosBusinessDay,loadLatestPosSyncRun } from './pos-business-day-refresh';
import { isEligiblePosFinalSync,posSnapshotTotals } from './pos-business-day-final-policy';
import { validPosBusinessDate,POS_BUCKETS } from '@/lib/ledger/pos-sales-source';
import { loadBusinessTimeAdapter } from '@/lib/store-settings/business-time-adapter';
import { addStoreDays } from '@/lib/store-settings/business-time-core';
export async function manualClosePosBusinessDay(origin:string,date:string,reclose=false,expectedSourceFingerprint?:string){
  const auth=await getAuthenticatedActor();if(!auth.ok)throw Error(auth.code);
  if(!validPosBusinessDate(date))throw Error('INVALID_POS_BUSINESS_DATE');
  return runManualCloseWorkflow({role:auth.actor.role,reclose},{
    eligible:async()=>(await getPosBusinessDayCloseTime(date)).allowed,
    refresh:()=>forceRefreshPosBusinessDay(origin,date),
    close:runId=>closePosBusinessDay(date,{reclose,syncRunId:runId,expectedSourceFingerprint}),
  });
}
export async function finalizePreviousPosBusinessDay(origin:string,now=new Date()){
  const adapter=await loadBusinessTimeAdapter(now);
  if(adapter.snapshot.isFallback)throw Error('POS_CLOSE_STORE_SETTING_UNAVAILABLE');
  const date=addStoreDays(adapter.databaseBusinessDate,-1);
  return finalizePosBusinessDay(origin,date,now);
}
export async function finalizePosBusinessDay(origin:string,date:string,now=new Date()){
  const actor=await resolvePosCloseSystemActor();
  const time=await getPosBusinessDayCloseTime(date,now);
  if(!time.allowed || Date.parse(time.cutoffAt)>now.getTime())throw Error('POS_FINAL_BEFORE_CUTOFF');
  const rpc=async(name:string,args:Record<string,unknown>)=>{
    const {data,error}=await supabaseServer.rpc(name,args);if(error)throw error;return data;
  };
  return runPosFinalWorkflow({date,cutoffAt:time.cutoffAt,now},{
    now:()=>new Date(),
    claim:async()=>{const result=await rpc('sales_claim_business_day_final_check_v1',{p_business_date:date,p_actor_user_id:actor.id});return result.status==='claimed'?result.token:null;},
    release:token=>rpc('sales_release_business_day_final_check_v1',{p_business_date:date,p_token:token,p_actor_user_id:actor.id}),
    latest:()=>loadLatestPosSyncRun(date,time.cutoffAt,true),refresh:()=>forceRefreshPosBusinessDay(origin,date),
    source:()=>loadPosBusinessDaySource(date),
    finalize:(token,run,source,failure,detail)=>rpc('sales_finalize_business_day_v1',{
      p_business_date:date,p_actor_user_id:actor.id,p_token:token,p_cutoff_at:time.cutoffAt,
      p_sync_run_id:run?.id??null,p_source_fingerprint:source?.sourceFingerprint??null,
      p_source_snapshot:source?.sourceSnapshot??null,p_rows:source?.rows??null,p_failure:failure,p_detail:detail,
    }),
  });
}
export async function getPosBusinessDayCloseView(date:string){
  const auth=await getAuthenticatedActor();if(!auth.ok)throw Error(auth.code);
  if(!['owner','master','manager','leader'].includes(auth.actor.role))throw Error('POS_CLOSE_FORBIDDEN');
  if(!validPosBusinessDate(date))throw Error('INVALID_POS_BUSINESS_DATE');
  const [source,time,latest,check,month,run,ledger]=await Promise.all([
    loadPosBusinessDaySource(date).catch(()=>null),getPosBusinessDayCloseTime(date),
    supabaseServer.from('pos_sales_business_day_closures').select('id,revision,close_method,closed_at,closed_by,source_fingerprint,source_snapshot,actor:users!closed_by(name,full_name,username)')
      .eq('business_date',date).order('revision',{ascending:false}).limit(1).maybeSingle(),
    supabaseServer.from('pos_sales_business_day_close_checks').select('id,closure_id,result,checked_at,closed_total,current_total,total_delta,closed_buckets,current_buckets,bucket_delta')
      .eq('business_date',date).order('checked_at',{ascending:false}).order('id',{ascending:false}).limit(1).maybeSingle(),
    supabaseServer.from('ledger_month_closures').select('id').eq('month',date.slice(0,7)+'-01').eq('status','closed').maybeSingle(),
    loadLatestPosSyncRun(date),
    supabaseServer.from('ledger_transactions').select('source_key,amount,status,source_fingerprint,movements:ledger_movements(amount)')
      .eq('source_type','pos_sales_daily_payment').eq('business_date',date),
  ]);
  for(const result of [latest,check,month,ledger])if(result.error)throw result.error;
  const closure=latest.data;
  const totals=source?{total:source.receiptTotal,cash:source.cash,transfer:source.transfer,card:source.card,other:source.other}:null;
  const closedTotals=closure?posSnapshotTotals(closure.source_snapshot):null;
  const delta=totals&&closedTotals?{total:totals.total-closedTotals.total,cash:totals.cash-closedTotals.cash,
    transfer:totals.transfer-closedTotals.transfer,card:totals.card-closedTotals.card,other:totals.other-closedTotals.other}:null;
  const rows=closure?.source_snapshot?.rows as {bucket:string;amount:number;fingerprint:string}[]|undefined;
  const matches=closure&&rows?.length===4&&rows.every(row=>{
    const tx=ledger.data?.find(t=>t.source_key==='pos:'+date+':'+row.bucket);
    return Number(row.amount)===0?tx?.status!=='confirmed':tx?.status==='confirmed'&&Number(tx.amount)===Number(row.amount)
      &&tx.source_fingerprint===row.fingerprint&&tx.movements.reduce((sum,m)=>sum+Number(m.amount),0)===Number(tx.amount);
  });
  const drift=Boolean(closure&&source&&closure.source_fingerprint!==source.sourceFingerprint);
  const writable=['owner','master','manager'].includes(auth.actor.role),reclosable=['owner','master'].includes(auth.actor.role);
  const latestCheck=check.data&&(!closure||Number(check.data.closure_id)===Number(closure.id)
    ||(!check.data.closure_id&&check.data.checked_at>=closure.closed_at))?check.data:null;
  const relation=closure?.actor;
  const closeActor=Array.isArray(relation)?relation[0]:relation;
  return {businessDate:date,currentTotals:totals,currentFingerprint:source?.sourceFingerprint??null,sourceValid:Boolean(source),
    latestClose:closure?{id:Number(closure.id),revision:closure.revision,method:closure.close_method,closedAt:closure.closed_at,
      closedBy:closure.close_method==='automatic'?'System':closeActor?.name||closeActor?.full_name||closeActor?.username||'',
      totals:closedTotals,fingerprint:closure.source_fingerprint}:null,
    latestFinalCheck:latestCheck?{id:Number(latestCheck.id),result:latestCheck.result,checkedAt:latestCheck.checked_at,
      closedTotal:latestCheck.closed_total===null?null:Number(latestCheck.closed_total),currentTotal:latestCheck.current_total===null?null:Number(latestCheck.current_total),
      totalDelta:latestCheck.total_delta===null?null:Number(latestCheck.total_delta),closedBuckets:latestCheck.closed_buckets,
      currentBuckets:latestCheck.current_buckets,bucketDelta:latestCheck.bucket_delta}:null,
    drift,delta,canClose:writable&&time.allowed&&!month.data&&!closure&&Boolean(source),
    canReclose:reclosable&&time.allowed&&!month.data&&Boolean(closure)&&drift&&Boolean(source),
    needsOwnerReview:drift&&!reclosable&&Boolean(delta&&Object.values(delta).some(amount=>amount!==0)),monthClosed:Boolean(month.data),
    closeEligibilityReason:!source?'source_invalid':month.data?'month_closed':!time.allowed?time.reason:!writable?'forbidden':closure?'already_closed':'eligible',
    closeAt:time.closeAt,finalSync:{runId:run?.id??null,lastSyncedAt:run?.finished_at??null,
      cutoffAt:time.cutoffAt,eligible:isEligiblePosFinalSync(run,date,time.cutoffAt,new Date())},
    ledgerProjection:{status:closure?(matches?'matches_close':'mismatch'):'not_closed',
      total:(ledger.data??[]).filter(t=>t.status==='confirmed').reduce((sum,t)=>sum+Number(t.amount),0)},
    buckets:POS_BUCKETS,
  };
}
