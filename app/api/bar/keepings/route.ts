import { NextRequest, NextResponse } from "next/server";
import { canManageBarKeeping, canReactivateBarKeeping, canViewBar } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { KEEPING_LIST_LIMIT, KEEPING_LIST_MAX_LIMIT, isKeepingCloseReason, isKeepingSort, keepingExpiryState, maskCustomerIdentifier } from "@/lib/bar/keeping";
import { isBarZoneCode } from "@/lib/bar/zone-map";
import { cleanDate, cleanPercent, cleanText, removeKeepingFiles, signedUrl, uploadKeepingFiles, validKeepingZone } from "@/lib/bar/keeping-server";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const { actor, response } = await getBarServerActor(); if (response || !actor) return response;
    if (!canViewBar(actor)) return NextResponse.json({ok:false,error:"Forbidden"},{status:403});
    const params=request.nextUrl.searchParams; const status=params.get("status") ?? "active"; if(!["active","closed","all"].includes(status)) return bad("Invalid status");
    const sort=params.get("sort") ?? "recent_activity"; if(!isKeepingSort(sort)) return bad("Invalid sort");
    const limit=Number(params.get("limit") ?? KEEPING_LIST_LIMIT); if(!Number.isInteger(limit)||limit<1||limit>KEEPING_LIST_MAX_LIMIT) return bad("Invalid limit");
    const offset=parseCursor(params.get("cursor")); if(offset===null) return bad("Invalid cursor");
    let query=supabaseServer.from("bar_keepings").select("id,customer_name,customer_identifier,liquor_name,zone_code,status,close_reason,remaining_percent,thumbnail_path,stored_at,last_used_at,expires_at,updated_at",{count:"exact"});
    if(status!=="all") query=query.eq("status",status); const zone=params.get("zone"); if(zone){if(!isBarZoneCode(zone)||zone==="A2")return bad("Invalid zone");query=query.eq("zone_code",zone);}
    const reason=params.get("closeReason"); if(reason){if(!isKeepingCloseReason(reason)) return bad("Invalid close reason"); query=query.eq("close_reason",reason);}
    const q=(params.get("q")??"").trim().replace(/[,_%()."'\\]/g," ").trim().slice(0,80); if(q) query=query.or(`customer_name.ilike.%${q}%,customer_identifier.ilike.%${q}%,liquor_name.ilike.%${q}%,zone_code.ilike.%${q}%`);
    const expiry=params.get("expiry");if(expiry&&!['soon','expired'].includes(expiry))return bad("Invalid expiry filter");
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh"}).format(new Date());
    if(expiry==="expired") query=query.lt("expires_at",today); if(expiry==="soon"){const future=new Date(`${today}T12:00:00+07:00`);future.setUTCDate(future.getUTCDate()+14);query=query.gte("expires_at",today).lte("expires_at",new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh"}).format(future));}
    const orders:Record<string,[string,boolean]>={recent_activity:["updated_at",false],old_activity:["updated_at",true],recent_created:["id",false],customer_name:["customer_name",true],zone:["zone_code",true],expiry_soon:["expires_at",true]};
    const [column,ascending]=orders[sort]; query=query.order(column,{ascending,nullsFirst:false}).order("id",{ascending});
    const {data,error,count}=await query.range(offset,offset+limit); if(error) throw error; const rows=(data??[]).slice(0,limit); const hasMore=(data?.length??0)>limit;
    const items=await Promise.all(rows.map(async row=>{const expiryState=keepingExpiryState(row.expires_at);return{id:Number(row.id),customerName:row.customer_name,customerIdentifierMasked:maskCustomerIdentifier(row.customer_identifier),liquorName:row.liquor_name,zoneCode:row.zone_code,status:row.status,closeReason:row.close_reason,remainingPercent:row.remaining_percent,thumbnailUrl:await signedUrl(row.thumbnail_path),storedAt:row.stored_at,lastUsedAt:row.last_used_at,expiresAt:row.expires_at,updatedAt:row.updated_at,...expiryState};}));
    return NextResponse.json({ok:true,items,total:count??0,hasMore,nextCursor:hasMore?Buffer.from(String(offset+limit)).toString("base64url"):null,capabilities:{manage:canManageBarKeeping(actor),reactivate:canReactivateBarKeeping(actor)}});
  } catch(error){console.error("[KEEPINGS_GET_ERROR]",error);return NextResponse.json({ok:false,error:"Failed to load keepings"},{status:500});}
}

export async function POST(request: NextRequest) {
  let paths:{imagePath:string;thumbnailPath:string}|null=null;
  try{
    const {actor,response}=await getBarServerActor();if(response||!actor)return response;if(!canManageBarKeeping(actor))return NextResponse.json({ok:false,error:"Forbidden"},{status:403});
    const form=await request.formData();const customerName=cleanText(form.get("customerName"),120,true),identifier=cleanText(form.get("customerIdentifier"),120),liquorName=cleanText(form.get("liquorName"),160,true),note=cleanText(form.get("note"),3000),zone=cleanText(form.get("zoneCode"),8,true),percent=cleanPercent(form.get("remainingPercent")),storedAt=cleanDate(form.get("storedAt"),true),expiresAt=cleanDate(form.get("expiresAt"));
    const detail=form.get("image"),thumb=form.get("thumbnail");if(customerName===undefined||identifier===undefined||liquorName===undefined||note===undefined||!zone||percent===undefined||!storedAt||expiresAt===undefined||!(detail instanceof File)||!(thumb instanceof File))return bad("Invalid keeping data");
    if(!await validKeepingZone(zone))return bad("Invalid keeping zone");paths=await uploadKeepingFiles(detail,thumb);
    const {data,error}=await supabaseServer.rpc("bar_create_keeping",{p_customer_name:customerName,p_customer_identifier:identifier,p_liquor_name:liquorName,p_note:note,p_zone_code:zone,p_remaining_percent:percent,p_image_path:paths.imagePath,p_thumbnail_path:paths.thumbnailPath,p_stored_at:storedAt,p_expires_at:expiresAt,p_actor_user_id:actor.id});if(error)throw error;
    if(data?.status!=="ok"){await removeKeepingFiles([paths.imagePath,paths.thumbnailPath],"KEEPING_CREATE_COMPENSATION");return bad("Could not create keeping");}paths=null;return NextResponse.json({ok:true,id:Number(data.id),version:data.version},{status:201});
  }catch(error){if(paths)await removeKeepingFiles([paths.imagePath,paths.thumbnailPath],"KEEPING_CREATE_COMPENSATION");console.error("[KEEPING_CREATE_ERROR]",error);return NextResponse.json({ok:false,error:"Failed to create keeping"},{status:500});}
}
function bad(error:string){return NextResponse.json({ok:false,error,code:"INVALID_INPUT"},{status:400});}
function parseCursor(value:string|null){if(!value)return 0;if(value.length>32||!/^[A-Za-z0-9_-]+$/.test(value))return null;try{const n=Number(Buffer.from(value,"base64url").toString("utf8"));return Number.isSafeInteger(n)&&n>=0&&n<=10_000_000?n:null;}catch{return null;}}
