import { authorizeCron } from '@/lib/pos/cukcuk/sales-sync-cron-shared';
import { finalizePreviousPosBusinessDay } from '@/lib/sales/pos-business-day-final';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=180;
export async function GET(req:Request){
  const denied=authorizeCron(req);if(denied)return denied;
  try{
    const result=await finalizePreviousPosBusinessDay(new URL(req.url).origin);
    return Response.json({ok:!['sync_failed','source_invalid','month_closed','forbidden'].includes(result.status),...result});
  }catch{return Response.json({ok:false,code:'POS_FINAL_CHECK_FAILED'},{status:500});}
}
