import { NextRequest, NextResponse } from "next/server";
import { canDeleteBarKeeping, canEditClosedBarKeeping, canManageBarKeeping, canReactivateBarKeeping, canViewBar } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { cleanId, KEEPING_SELECT, mapKeeping, removeKeepingFiles } from "@/lib/bar/keeping-server";
import { barZones } from "@/lib/bar/zone-map";
import { supabaseServer } from "@/lib/supabase/server";
type Context={params:Promise<{id:string}>};

export async function GET(_request:NextRequest,context:Context){
  try{const {actor,response}=await getBarServerActor();if(response||!actor)return response;if(!canViewBar(actor))return NextResponse.json({ok:false,error:"Forbidden"},{status:403});
    const id=cleanId((await context.params).id);if(!id)return NextResponse.json({ok:false,error:"Invalid keeping id"},{status:400});
    const {data,error}=await supabaseServer.from("bar_keepings").select(KEEPING_SELECT).eq("id",id).maybeSingle();if(error)throw error;if(!data)return NextResponse.json({ok:false,error:"Keeping not found"},{status:404});
    const item=await mapKeeping(data,true);const zone=barZones.find(candidate=>candidate.code===item.zoneCode);if(zone){item.zoneLabelKo=zone.labelKo;item.zoneLabelVi=zone.labelVi;}
    return NextResponse.json({ok:true,item,capabilities:{view:true,manage:canManageBarKeeping(actor),reactivate:canReactivateBarKeeping(actor),editClosed:canEditClosedBarKeeping(actor),delete:canDeleteBarKeeping(actor)}});
  }catch(error){console.error("[KEEPING_DETAIL_ERROR]",error);return NextResponse.json({ok:false,error:"Failed to load keeping"},{status:500});}}

export async function DELETE(request:NextRequest,context:Context){
  try{
    const {actor,response}=await getBarServerActor();if(response||!actor)return response;
    if(!canDeleteBarKeeping(actor))return NextResponse.json({ok:false,error:"Forbidden"},{status:403});
    const id=cleanId((await context.params).id);if(!id)return NextResponse.json({ok:false,error:"Invalid keeping id"},{status:400});
    let body:unknown;try{body=await request.json();}catch{return NextResponse.json({ok:false,error:"Invalid request"},{status:400});}
    const version=typeof body==="object"&&body!==null&&"version" in body?Number(body.version):NaN;
    if(!Number.isSafeInteger(version)||version<1)return NextResponse.json({ok:false,error:"Invalid version"},{status:400});
    const {data,error}=await supabaseServer.rpc("bar_delete_keeping_v2",{p_id:id,p_expected_version:version,p_actor_user_id:actor.id});
    if(error)throw error;
    if(data?.status==="conflict")return NextResponse.json({ok:false,error:"Another user updated this keeping",code:"VERSION_CONFLICT",version:data.version},{status:409});
    if(data?.status==="not_found")return NextResponse.json({ok:false,error:"Keeping not found"},{status:404});
    if(data?.status==="forbidden")return NextResponse.json({ok:false,error:"Forbidden"},{status:403});
    if(data?.status==="invalid_state")return NextResponse.json({ok:false,error:"This keeping cannot be deleted in its current state",code:"INVALID_STATE"},{status:409});
    if(data?.status!=="ok")throw new Error("Unexpected delete keeping status");
    const cleanup=await removeKeepingFiles([data.old_image_path,data.old_thumbnail_path],"KEEPING_DELETE_STORAGE_CLEANUP");
    if(!cleanup.succeeded)console.warn("[KEEPING_DELETE_STORAGE_CLEANUP_WARNING]",{keepingId:id,attempted:cleanup.attempted});
    return NextResponse.json({ok:true,id,zoneCode:data.zone_code,storageCleanupSucceeded:cleanup.succeeded});
  }catch(error){console.error("[KEEPING_DELETE_ERROR]",error);return NextResponse.json({ok:false,error:"Failed to delete keeping"},{status:500});}
}
