import 'server-only';
import { supabaseServer } from '@/lib/supabase/server';
import { type PosFinalSyncRun } from './pos-business-day-final-policy';
export async function loadLatestPosSyncRun(businessDate:string,cutoffAt?:string,includeIncomplete=false):Promise<PosFinalSyncRun|null>{
  let query=supabaseServer.from('pos_sales_sync_runs').select('id,business_date,source,status,source_complete,started_at,finished_at,error_message')
    .eq('business_date',businessDate).eq('source','cukcuk');
  if(!includeIncomplete)query=query.eq('status','success').eq('source_complete',true).is('error_message',null);
  query=query.order(includeIncomplete?'started_at':'finished_at',{ascending:false}).limit(1);
  if(cutoffAt) query=query.gte('started_at',cutoffAt);
  const {data,error}=await query.maybeSingle();if(error)throw error;
  return data?{...data,id:Number(data.id)}:null;
}
export async function forceRefreshPosBusinessDay(origin:string,businessDate:string){
  const secret=process.env.POS_ADMIN_SECRET?.trim();if(!secret)throw Error('POS_CLOSE_SYNC_FAILED');
  const response=await fetch(new URL('/api/pos/cukcuk/sainvoices/sync-to-sales',origin),{
    method:'POST',headers:{'Content-Type':'application/json','x-pos-admin-secret':secret},
    body:JSON.stringify({businessDate,force:true,limit:100}),cache:'no-store',signal:AbortSignal.timeout(120000),
  });
  const data=await response.json().catch(()=>null);
  if(!response.ok || data?.ok!==true || data?.skipped===true)throw Error('POS_CLOSE_SYNC_FAILED');
  if(data.warning || data.result?.warning || Number(data.result?.skippedDetailCount)>0
    || Number(data.result?.paymentSnapshotUnavailableCount)>0)throw Error('POS_CLOSE_SOURCE_INVALID');
  const runId=Number(data.result?.syncRunId);
  if(!Number.isSafeInteger(runId)||runId<1)throw Error('POS_CLOSE_SYNC_FAILED');
  const {data:run,error}=await supabaseServer.from('pos_sales_sync_runs')
    .select('id,business_date,status,source_complete,error_message').eq('id',runId).eq('business_date',businessDate).maybeSingle();
  if(error)throw error;
  if(!run || run.status!=='success' || run.source_complete!==true || run.error_message!==null)throw Error('POS_CLOSE_SOURCE_INVALID');
  return runId;
}
