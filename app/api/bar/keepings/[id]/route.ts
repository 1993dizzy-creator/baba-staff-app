import { NextRequest, NextResponse } from "next/server";
import { canEditClosedBarKeeping, canManageBarKeeping, canReactivateBarKeeping, canViewBar } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { cleanId, KEEPING_SELECT, mapKeeping } from "@/lib/bar/keeping-server";
import { barZones } from "@/lib/bar/zone-map";
import { supabaseServer } from "@/lib/supabase/server";
type Context={params:Promise<{id:string}>};

export async function GET(_request:NextRequest,context:Context){
  try{const {actor,response}=await getBarServerActor();if(response||!actor)return response;if(!canViewBar(actor))return NextResponse.json({ok:false,error:"Forbidden"},{status:403});
    const id=cleanId((await context.params).id);if(!id)return NextResponse.json({ok:false,error:"Invalid keeping id"},{status:400});
    const {data,error}=await supabaseServer.from("bar_keepings").select(KEEPING_SELECT).eq("id",id).maybeSingle();if(error)throw error;if(!data)return NextResponse.json({ok:false,error:"Keeping not found"},{status:404});
    const item=await mapKeeping(data,true);const zone=barZones.find(candidate=>candidate.code===item.zoneCode);if(zone){item.zoneLabelKo=zone.labelKo;item.zoneLabelVi=zone.labelVi;}
    return NextResponse.json({ok:true,item,capabilities:{view:true,manage:canManageBarKeeping(actor),reactivate:canReactivateBarKeeping(actor),editClosed:canEditClosedBarKeeping(actor)}});
  }catch(error){console.error("[KEEPING_DETAIL_ERROR]",error);return NextResponse.json({ok:false,error:"Failed to load keeping"},{status:500});}}
