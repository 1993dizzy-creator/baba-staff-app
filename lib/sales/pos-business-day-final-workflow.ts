// @ts-expect-error Direct Node tests require explicit extensions.
import { isEligiblePosFinalSync, type PosFinalSyncRun } from './pos-business-day-final-policy.ts';
// @ts-expect-error Direct Node tests require explicit extensions.
import { canWritePosBusinessDayClose } from './pos-business-day-close-policy.ts';
import type { PosBusinessDaySource } from '../ledger/pos-sales-source.ts';
export async function runManualCloseWorkflow<T>(args:{role:string;reclose:boolean}, deps:{
  eligible:()=>Promise<boolean>;refresh:()=>Promise<number>;close:(runId:number)=>Promise<T>;
}) {
  if(!canWritePosBusinessDayClose(args.role,args.reclose)) throw Error('POS_CLOSE_FORBIDDEN');
  if(!await deps.eligible()) throw Error('POS_CLOSE_BEFORE_CONFIGURED_CLOSE_TIME');
  const runId=await deps.refresh();
  return deps.close(runId);
}
export async function runPosFinalWorkflow<T>(args:{date:string;cutoffAt:string;now:Date},deps:{
  claim:()=>Promise<string|null>;release:(token:string)=>Promise<void>;
  now:()=>Date;latest:()=>Promise<PosFinalSyncRun|null>;refresh:()=>Promise<number>;
  source:()=>Promise<PosBusinessDaySource>;
  finalize:(token:string,run:PosFinalSyncRun|null,source:PosBusinessDaySource|null,failure:'sync_failed'|'source_invalid'|null,detail:Record<string,unknown>)=>Promise<T>;
}) {
  const token=await deps.claim();
  if(!token) return {status:'in_progress'};
  let run:PosFinalSyncRun|null=null;
  let retryExecuted=false;
  let finalSyncEligible=false;
  let syncLookupFailed=false;
  const detail=(reason:string|null,retryFailureReason:string|null=null)=>({
    businessDate:args.date,reason,failureCode:reason,cutoffAt:args.cutoffAt,
    finalSync:{eligible:finalSyncEligible,runId:run?.id??null,status:run?.status??null,
      sourceComplete:run?.source_complete??null,lookupFailed:syncLookupFailed},
    retryExecuted,retryFailureReason,syncRunId:run?.id??null,
  });
  try{
    try{run=await deps.latest();}catch{syncLookupFailed=true;}
    finalSyncEligible=isEligiblePosFinalSync(run,args.date,args.cutoffAt,args.now);
    if(!finalSyncEligible){
      retryExecuted=true;
      try {await deps.refresh();run=await deps.latest();}
      catch(error){
        // Store diagnostic codes only; upstream error messages may contain credentials.
        const sourceInvalid=error instanceof Error && error.message==='POS_CLOSE_SOURCE_INVALID';
        try{run=await deps.latest();}catch{/* Retain the last known run when diagnostics cannot be loaded. */}
        return await deps.finalize(token,run,null,sourceInvalid?'source_invalid':'sync_failed',
          detail('final_sync_retry_failed',sourceInvalid?'POS_CLOSE_SOURCE_INVALID':'POS_CLOSE_SYNC_FAILED'));
      }
      finalSyncEligible=isEligiblePosFinalSync(run,args.date,args.cutoffAt,deps.now());
      if(!finalSyncEligible)
        return await deps.finalize(token,run,null,'sync_failed',detail('eligible_final_sync_missing_after_retry'));
    }
    let source:PosBusinessDaySource;
    try{source=await deps.source();}
    catch{return await deps.finalize(token,run,null,'source_invalid',detail('source_reconciliation_or_completeness_failed'));}
    try{return await deps.finalize(token,run,source,null,detail(null));}
    catch(error){
      const code=(error as {code?:string})?.code;
      if(code!=='22023' && code!=='40001' && code!=='P0001') throw error;
      return await deps.finalize(token,run,null,'source_invalid',detail('atomic_live_source_validation_failed'));
    }
  }finally{await deps.release(token);}
}
