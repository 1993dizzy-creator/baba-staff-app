import { NextRequest,NextResponse } from "next/server";
import { canEditClosedBarKeeping,canManageBarKeeping,canReactivateBarKeeping } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { isKeepingCloseReason } from "@/lib/bar/keeping";
import { cleanDate,cleanDateTime,cleanId,cleanPercent,cleanText,cleanVersion,removeKeepingFiles,resolveKeepingLiquor,uploadKeepingFiles,validKeepingZone } from "@/lib/bar/keeping-server";
import { supabaseServer } from "@/lib/supabase/server";
type Context={params:Promise<{id:string}>};
const ACTIONS=new Set(["update","update_with_move","use","correct_remaining","move","replace_photo","close","reactivate"]);

export async function POST(request:NextRequest,context:Context){
  let uploaded:{imagePath:string;thumbnailPath:string}|null=null;
  try{const {actor,response}=await getBarServerActor();if(response||!actor)return response;if(!canManageBarKeeping(actor))return forbidden();
    const id=cleanId((await context.params).id);if(!id)return bad("Invalid keeping id");const form=await request.formData();const action=String(form.get("action")??"");const version=cleanVersion(form.get("version"));if(!ACTIONS.has(action)||!version)return bad("Invalid action");
    const {data:current,error:currentError}=await supabaseServer.from("bar_keepings").select("status,image_path,thumbnail_path,zone_code").eq("id",id).maybeSingle();if(currentError)throw currentError;if(!current)return NextResponse.json({ok:false,error:"Keeping not found"},{status:404});
    if(action==="reactivate"&&!canReactivateBarKeeping(actor))return forbidden();if(current.status==="closed"&&action==="replace_photo"&&!canEditClosedBarKeeping(actor))return forbidden();if(current.status==="closed"&&!new Set(["replace_photo","reactivate"]).has(action))return conflict("Invalid state");
    let raw:Record<string,unknown>;try{raw=JSON.parse(String(form.get("payload")??"{}"));}catch{return bad("Invalid payload");}
    const validated=await validate(action,raw,current.zone_code,canEditClosedBarKeeping(actor));if(!validated)return bad("Invalid action data");const payload:Record<string,unknown>=validated;
    const detail=form.get("image"),thumb=form.get("thumbnail");const hasFiles=detail instanceof File&&detail.size>0||thumb instanceof File&&thumb.size>0;
    if(hasFiles){if(!(detail instanceof File)||!(thumb instanceof File))return bad("Both image sizes are required");uploaded=await uploadKeepingFiles(detail,thumb);payload.image_path=uploaded.imagePath;payload.thumbnail_path=uploaded.thumbnailPath;}
    if(action==="replace_photo"&&!uploaded)return bad("Photo is required");
    const rpc=action==="update_with_move"?"bar_update_and_move_keeping":"bar_mutate_keeping_v5";const {data,error}=await supabaseServer.rpc(rpc,{p_id:id,p_expected_version:version,...(action==="update_with_move"?{p_update_payload:payload.update,p_move_payload:payload.move}:{p_action:action,p_payload:payload}),p_actor_user_id:actor.id});if(error)throw error;
    if(data?.status!=="ok"){if(uploaded)await removeKeepingFiles([uploaded.imagePath,uploaded.thumbnailPath],"KEEPING_ACTION_COMPENSATION");if(data?.status==="conflict")return NextResponse.json({ok:false,error:"Another user updated this keeping",code:"VERSION_CONFLICT",version:data.version},{status:409});if(["invalid_state","same_zone"].includes(data?.status))return conflict("Invalid keeping state");return bad("Invalid action data");}
    uploaded=null;if(payload.image_path)await removeKeepingFiles([data.old_image_path,data.old_thumbnail_path],"KEEPING_OLD_PHOTO_CLEANUP");return NextResponse.json({ok:true,version:data.version});
  }catch(error){if(uploaded)await removeKeepingFiles([uploaded.imagePath,uploaded.thumbnailPath],"KEEPING_ACTION_COMPENSATION");console.error("[KEEPING_ACTION_ERROR]",error);return NextResponse.json({ok:false,error:"Failed to update keeping"},{status:500});}}

async function validate(action:string,raw:Record<string,unknown>,currentZone:string,allowClosed:boolean):Promise<Record<string,unknown>|null>{
  if(action==="update_with_move"){const update=await validate("update",raw,currentZone,allowClosed),move=await validate("move",raw,currentZone,allowClosed);return update&&move?{update,move}:null;}
  if(action==="update"){const customer_name=cleanText(raw.customerName,120,true),customer_contact=cleanText(raw.customerContact,120),customer_identifier=cleanText(raw.customerIdentifier,120),liquor=await resolveKeepingLiquor(raw.liquorSource,raw.inventoryItemId,raw.liquorName),note=cleanText(raw.note,3000),stored_at=cleanDate(raw.storedAt,true);if(customer_name===undefined||customer_contact===undefined||customer_identifier===undefined||!liquor||note===undefined||!stored_at)return null;return{customer_name,customer_contact,customer_identifier,liquor_name:liquor.liquorName,liquor_source:liquor.liquorSource,inventory_item_id:liquor.inventoryItemId,note,stored_at,allow_closed:allowClosed};}
  if(action==="use"){const remaining_percent=cleanPercent(raw.remainingPercent),used_at=cleanDateTime(raw.usedAt),note=cleanText(raw.note,1000);if(remaining_percent===undefined||!used_at||note===undefined)return null;return{remaining_percent,used_at,note,finish:remaining_percent===0&&raw.finish===true};}
  if(action==="correct_remaining"){const remaining_percent=cleanPercent(raw.remainingPercent),note=cleanText(raw.note,1000);return remaining_percent===undefined||note===undefined?null:{remaining_percent,note};}
  if(action==="move"){const zone_code=cleanText(raw.zoneCode,8,true);if(!zone_code||zone_code===currentZone||!await validKeepingZone(zone_code))return null;return{zone_code};}
  if(action==="replace_photo")return{};
  if(action==="close"){const close_reason=raw.closeReason,closed_at=cleanDateTime(raw.closedAt),note=cleanText(raw.note,1000);if(!isKeepingCloseReason(close_reason)||!closed_at||note===undefined)return null;return{close_reason,closed_at,note};}
  if(action==="reactivate"){const zone_code=cleanText(raw.zoneCode,8,true),remaining_percent=cleanPercent(raw.remainingPercent),stored_at=cleanDate(raw.storedAt,true),note=cleanText(raw.note,1000);if(!zone_code||remaining_percent===undefined||!stored_at||note===undefined||!await validKeepingZone(zone_code))return null;return{zone_code,remaining_percent,stored_at,note};}
  return null;
}
const bad=(error:string)=>NextResponse.json({ok:false,error,code:"INVALID_INPUT"},{status:400});const forbidden=()=>NextResponse.json({ok:false,error:"Forbidden"},{status:403});const conflict=(error:string)=>NextResponse.json({ok:false,error,code:"INVALID_STATE"},{status:409});
