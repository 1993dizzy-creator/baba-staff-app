import { getPosBusinessDayCloseView } from '@/lib/sales/pos-business-day-final';
import { posCloseApiError } from '@/lib/sales/pos-business-day-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:Request){
  try{return Response.json({ok:true,...await getPosBusinessDayCloseView(new URL(req.url).searchParams.get('businessDate')??'')});}
  catch(error){return posCloseApiError(error);}
}
