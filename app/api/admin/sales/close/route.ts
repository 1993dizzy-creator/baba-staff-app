import { manualClosePosBusinessDay } from '@/lib/sales/pos-business-day-final';
import { parsePosCloseBody,posCloseApiError } from '@/lib/sales/pos-business-day-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=180;
export async function POST(req:Request){
  try{
    const body=parsePosCloseBody(await req.json());
    const result=await manualClosePosBusinessDay(new URL(req.url).origin,body.date,body.reclose,body.expectedSourceFingerprint);
    return Response.json({ok:['closed','reclosed','already_closed'].includes(result.status),...result});
  }catch(error){return posCloseApiError(error);}
}
