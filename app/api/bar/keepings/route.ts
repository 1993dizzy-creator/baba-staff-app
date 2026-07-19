import { NextRequest, NextResponse } from "next/server";
import { canManageBarKeeping, canReactivateBarKeeping, canViewBar } from "@/lib/bar/permissions";
import { getBarServerActor } from "@/lib/bar/server-auth";
import { KEEPING_LIST_LIMIT, KEEPING_LIST_MAX_LIMIT, isKeepingCloseReason, isKeepingSort, keepingExpiryState, maskCustomerIdentifier } from "@/lib/bar/keeping";
import { isBarZoneCode } from "@/lib/bar/zone-map";
import { cleanDate, cleanPercent, cleanText, keepingImageDiagnostic, keepingInventoryNames, removeKeepingFiles, resolveKeepingLiquor, signedUrl, uploadKeepingFiles, validKeepingZone } from "@/lib/bar/keeping-server";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  try {
    const { actor, response } = await getBarServerActor(request); if (response || !actor) return response;
    const authFinishedAt = performance.now();
    if (!canViewBar(actor)) return NextResponse.json({ok:false,error:"Forbidden"},{status:403});
    const params=request.nextUrl.searchParams; const status=params.get("status") ?? "active"; if(!["active","closed","all"].includes(status)) return bad("Invalid status");
    const sort=params.get("sort") ?? "recent_activity"; if(!isKeepingSort(sort)) return bad("Invalid sort");
    const limit=Number(params.get("limit") ?? KEEPING_LIST_LIMIT); if(!Number.isInteger(limit)||limit<1||limit>KEEPING_LIST_MAX_LIMIT) return bad("Invalid limit");
    const offset=parseCursor(params.get("cursor")); if(offset===null) return bad("Invalid cursor");
    let query=supabaseServer.from("bar_keepings").select("id,customer_name,customer_identifier,liquor_name,liquor_source,inventory_item_id,use_count,zone_code,status,close_reason,remaining_percent,thumbnail_path,stored_at,last_used_at,expires_at,closed_at,updated_at");
    if(status!=="all") query=query.eq("status",status); const zone=params.get("zone"); if(zone){if(!isBarZoneCode(zone)||zone==="A2")return bad("Invalid zone");query=query.eq("zone_code",zone);}
    const reason=params.get("closeReason"); if(reason){if(!isKeepingCloseReason(reason)) return bad("Invalid close reason"); query=query.eq("close_reason",reason);}
    const q=(params.get("q")??"").trim().replace(/[,_%()."'\\]/g," ").trim().slice(0,80); if(q) query=query.or(`customer_name.ilike.%${q}%,customer_identifier.ilike.%${q}%,liquor_name.ilike.%${q}%,zone_code.ilike.%${q}%`);
    const expiry=params.get("expiry");if(expiry&&!['soon','expired'].includes(expiry))return bad("Invalid expiry filter");
    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh"}).format(new Date());
    if(expiry==="expired") query=query.lt("expires_at",today); if(expiry==="soon"){const future=new Date(`${today}T12:00:00+07:00`);future.setUTCDate(future.getUTCDate()+14);query=query.gte("expires_at",today).lte("expires_at",new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh"}).format(future));}
    const orders:Record<string,[string,boolean]>={recent_activity:["updated_at",false],old_activity:["updated_at",true],recent_created:["id",false],customer_name:["customer_name",true],zone:["zone_code",true],expiry_soon:["expires_at",true]};
    const [column,ascending]=orders[sort]; query=query.order(column,{ascending,nullsFirst:false}).order("id",{ascending});
    const {data,error}=await query.range(offset,offset+limit); if(error) throw error; const queryFinishedAt=performance.now();const rows=(data??[]).slice(0,limit); const hasMore=(data?.length??0)>limit;
    const inventoryNames=await keepingInventoryNames(rows.map(row=>row.inventory_item_id));
    const items=await Promise.all(rows.map(async row=>{const expiryState=keepingExpiryState(row.expires_at),names=inventoryNames.get(Number(row.inventory_item_id));return{id:Number(row.id),customerName:row.customer_name,customerIdentifierMasked:maskCustomerIdentifier(row.customer_identifier),liquorName:row.liquor_name,liquorNameKo:names?.ko??null,liquorNameVi:names?.vi??null,liquorSource:row.liquor_source,useCount:Number(row.use_count??0),zoneCode:row.zone_code,status:row.status,closeReason:row.close_reason,remainingPercent:row.remaining_percent,thumbnailUrl:await signedUrl(row.thumbnail_path),storedAt:row.stored_at,lastUsedAt:row.last_used_at,expiresAt:row.expires_at,closedAt:row.closed_at,updatedAt:row.updated_at,...expiryState};}));
    const finishedAt=performance.now();const result=NextResponse.json({ok:true,items,hasMore,nextCursor:hasMore?Buffer.from(String(offset+limit)).toString("base64url"):null,capabilities:{manage:canManageBarKeeping(actor),reactivate:canReactivateBarKeeping(actor)}});result.headers.set("Server-Timing",`auth;dur=${(authFinishedAt-startedAt).toFixed(1)},query;dur=${(queryFinishedAt-authFinishedAt).toFixed(1)},sign;dur=${(finishedAt-queryFinishedAt).toFixed(1)},total;dur=${(finishedAt-startedAt).toFixed(1)}`);return result;
  } catch(error){console.error("[KEEPINGS_GET_ERROR]",error);return NextResponse.json({ok:false,error:"Failed to load keepings"},{status:500});}
}

export async function POST(request: NextRequest) {
  let paths:{imagePath:string;thumbnailPath:string}|null=null;
  let stage="auth";
  try{
    const {actor,response}=await getBarServerActor(request);if(response||!actor)return response;if(!canManageBarKeeping(actor))return NextResponse.json({ok:false,error:"Forbidden"},{status:403});
    stage="form_data_parse";let form:FormData;try{form=await request.formData();}catch(error){console.error("[KEEPING_CREATE_STAGE]",{stage:"form_data_parse_failed",device:deviceSummary(request.headers.get("user-agent")),message:error instanceof Error?error.message:"Unknown error"});return createBad("KEEPING_INVALID_INPUT");}
    const customerRaw=form.get("customerName"),contactRaw=form.get("customerContact"),identifierRaw=form.get("customerIdentifier"),noteRaw=form.get("note"),storedAtRaw=form.get("storedAt");
    const customerName=cleanText(customerRaw,120,true),contact=cleanText(contactRaw,120),identifier=cleanText(identifierRaw,120),note=cleanText(noteRaw,3000),zone=cleanText(form.get("zoneCode"),8,true),percent=cleanPercent(form.get("remainingPercent")),storedAt=cleanDate(storedAtRaw,true);
    const source=form.get("liquorSource"),inventoryItemRaw=form.get("inventoryItemId");
    stage="resolve_liquor";const liquor=await resolveKeepingLiquor(source,inventoryItemRaw,form.get("liquorName"));
    const detail=form.get("image"),thumb=form.get("thumbnail");
    const detailDiagnostic=detail instanceof File?await keepingImageDiagnostic(detail):null,thumbnailDiagnostic=thumb instanceof File?await keepingImageDiagnostic(thumb):null;
    const parsed={device:deviceSummary(request.headers.get("user-agent")),actorId:actor.id,zoneCode:zone??null,liquorSource:typeof source==="string"?source:null,inventoryItemId:typeof inventoryItemRaw==="string"&&/^\d+$/.test(inventoryItemRaw)?Number(inventoryItemRaw):null,remainingPercent:percent??null,storedAt:{present:typeof storedAtRaw==="string"&&storedAtRaw.length>0,type:typeof storedAtRaw,formatValid:typeof storedAtRaw==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(storedAtRaw),valueValid:Boolean(storedAt)},customerName:textDiagnostic(customerRaw),contact:textDiagnostic(contactRaw),identifier:textDiagnostic(identifierRaw),note:textDiagnostic(noteRaw),detailImage:detailDiagnostic,thumbnailImage:thumbnailDiagnostic,liquorResolved:Boolean(liquor)};
    console.info("[KEEPING_CREATE_DIAGNOSTIC]",{stage:"parsed",...parsed});
    if(customerName===undefined||contact===undefined||identifier===undefined||!liquor||note===undefined||!zone||percent===undefined||!storedAt||!(detail instanceof File)||!(thumb instanceof File)){console.warn("[KEEPING_CREATE_STAGE]",{stage:"input_validation_failed",...parsed});return createBad(!liquor&&source==="inventory"?"KEEPING_INVALID_INVENTORY":"KEEPING_INVALID_INPUT");}
    if(!detailDiagnostic?.signatureValid||!thumbnailDiagnostic?.signatureValid){console.warn("[KEEPING_CREATE_STAGE]",{stage:"file_validation_failed",detailImage:detailDiagnostic,thumbnailImage:thumbnailDiagnostic});return createBad("KEEPING_INVALID_INPUT");}
    stage="zone_validation";const zoneValid=await validKeepingZone(zone);console.info("[KEEPING_CREATE_STAGE]",{stage:"zone_validated",zoneCode:zone,valid:zoneValid});if(!zoneValid)return createBad("KEEPING_INVALID_ZONE");
    stage="image_upload";paths=await uploadKeepingFiles(detail,thumb);
    console.info("[KEEPING_CREATE_DIAGNOSTIC]",{stage:"before_rpc",...parsed,zoneValid,imagePathsPresent:Boolean(paths.imagePath&&paths.thumbnailPath)});
    stage="rpc";const {data,error}=await supabaseServer.rpc("bar_create_keeping",{p_customer_name:customerName,p_customer_contact:contact,p_customer_identifier:identifier,p_liquor_source:liquor.liquorSource,p_inventory_item_id:liquor.inventoryItemId,p_liquor_name:liquor.liquorName,p_note:note,p_zone_code:zone,p_remaining_percent:percent,p_image_path:paths.imagePath,p_thumbnail_path:paths.thumbnailPath,p_stored_at:storedAt,p_expires_at:null,p_actor_user_id:actor.id});
    if(error){console.error("[KEEPING_CREATE_STAGE]",{stage:"rpc_error",code:error.code,message:error.message});throw error;}
    const status=typeof data?.status==="string"?data.status:"unknown";
    if(status!=="ok"){console.warn("[KEEPING_CREATE_STAGE]",{stage:"rpc_non_ok",status});await removeKeepingFiles([paths.imagePath,paths.thumbnailPath],"KEEPING_CREATE_COMPENSATION");paths=null;return createBad(rpcResponseCode(status));}
    paths=null;console.info("[KEEPING_CREATE_STAGE]",{stage:"success",keepingId:Number(data.id),device:parsed.device});return NextResponse.json({ok:true,id:Number(data.id),version:data.version},{status:201});
  }catch(error){if(paths)await removeKeepingFiles([paths.imagePath,paths.thumbnailPath],"KEEPING_CREATE_COMPENSATION");console.error("[KEEPING_CREATE_ERROR]",{stage,code:typeof error==="object"&&error&&"code"in error?String(error.code):null,message:error instanceof Error?error.message:"Unknown error"});return NextResponse.json({ok:false,error:"Failed to create keeping",code:"KEEPING_CREATE_FAILED"},{status:500});}
}
function bad(error:string){return NextResponse.json({ok:false,error,code:"INVALID_INPUT"},{status:400});}
function createBad(code:string){return NextResponse.json({ok:false,error:"Could not create keeping",code},{status:400});}
function rpcResponseCode(status:string){return status==="invalid_inventory_item"?"KEEPING_INVALID_INVENTORY":status==="invalid_zone"?"KEEPING_INVALID_ZONE":status==="invalid_actor"?"KEEPING_INVALID_ACTOR":status==="invalid_input"?"KEEPING_INVALID_INPUT":"KEEPING_CREATE_FAILED";}
function textDiagnostic(value:FormDataEntryValue|null){return{present:typeof value==="string"&&value.length>0,type:typeof value,length:typeof value==="string"?value.length:null,trimmedLength:typeof value==="string"?value.trim().length:null};}
function deviceSummary(userAgent:string|null){const ua=userAgent??"";if(/iPhone|iPad|iPod/i.test(ua))return /CriOS/i.test(ua)?"iOS/Chrome":"iOS/Safari";if(/Android/i.test(ua))return /Chrome|CriOS/i.test(ua)?"Android/Chrome":"Android/Other";return"Other";}
function parseCursor(value:string|null){if(!value)return 0;if(value.length>32||!/^[A-Za-z0-9_-]+$/.test(value))return null;try{const n=Number(Buffer.from(value,"base64url").toString("utf8"));return Number.isSafeInteger(n)&&n>=0&&n<=10_000_000?n:null;}catch{return null;}}
