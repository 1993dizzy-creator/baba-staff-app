import { readFileSync } from 'node:fs';
import { posCloseDatabase,initializePosCloseDatabase,daySource } from './pos-business-day-close-fixture.mjs';
export const finalMigration=readFileSync('supabase/migrations/20260912112349_add_pos_business_day_close_checks.sql','utf8');
export async function seedPosFinalDatabase(db){
 await db.exec(finalMigration);
 const clock=(await db.query(`select ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')-interval '3 hours')::date::text cutoff_date`)).rows[0].cutoff_date;
 const date=new Date(Date.parse(clock+'T00:00:00Z')-86400000).toISOString().slice(0,10),cutoffAt=clock+'T03:00:00+07:00';
 await db.query('update pos_sales_receipts set business_date=$1 where id=1',[date]);
 await db.query('update pos_sales_receipt_payments set business_date=$1 where receipt_id=1',[date]);
 await db.query(`insert into pos_sales_sync_runs(id,business_date,source,status,source_complete,started_at,finished_at)
  values(100,$1,'cukcuk','success',true,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute')`,[date]);
 return {date,cutoffAt};
}
export async function posFinalDatabase(){const db=await posCloseDatabase();try{return {db,...await seedPosFinalDatabase(db)};}catch(e){await db.close();throw e;}}
export async function initializePosFinalDatabase(db){await initializePosCloseDatabase(db);return seedPosFinalDatabase(db);}
export async function claimFinal(db,date){return (await db.query('select sales_claim_business_day_final_check_v1($1,2) result',[date])).rows[0].result;}
export async function releaseFinal(db,date,token){await db.query('select sales_release_business_day_final_check_v1($1,$2,2)',[date,token]);}
export async function finalCheck(db,context,{token,source=null,failure=null,run=100}={}){
 if(!token){const claim=await claimFinal(db,context.date);token=claim.token;}
 const args=[context.date,2,token,context.cutoffAt,run,source?.sourceFingerprint??null,source?JSON.stringify(source.sourceSnapshot):null,source?JSON.stringify(source.rows):null,failure,{}];
 try{return (await db.query('select sales_finalize_business_day_v1($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb) result',args)).rows[0].result;}
 finally{await releaseFinal(db,context.date,token);}
}
export {daySource};
