import type { BarActivityLog } from "@/lib/bar/types";
export type BarLanguage = "ko" | "vi";

const numberValue=(data:Record<string,unknown>|null|undefined,key:string)=>typeof data?.[key]==="number"?data[key] as number:null;
const stringValue=(data:Record<string,unknown>|null|undefined,key:string)=>typeof data?.[key]==="string"?data[key] as string:null;
const nonBlankString=(data:Record<string,unknown>|null|undefined,key:string)=>{const value=stringValue(data,key)?.trim();return value||null;};
export function getBarLogNote(log:BarActivityLog){
  if(log.actionType==="keeping_updated"){
    const before=nonBlankString(log.beforeData,"note"),after=nonBlankString(log.afterData,"note");
    return before!==after?after:null;
  }
  if(!["keeping_used","keeping_remaining_corrected","keeping_closed"].includes(log.actionType))return null;
  if(log.afterData&&Object.prototype.hasOwnProperty.call(log.afterData,"action_note"))return nonBlankString(log.afterData,"action_note");
  const legacyKey=log.actionType==="keeping_used"?"note":log.actionType==="keeping_remaining_corrected"?"reason":"close_note";
  return nonBlankString(log.afterData,legacyKey);
}
const liquorSourceLabel=(value:string|null,lang:BarLanguage)=>value==="inventory"?(lang==="vi"?"hàng của quán":"판매상품"):value==="external"?(lang==="vi"?"mang từ ngoài":"외부반입"):(lang==="vi"?"chưa phân loại":"구분 미지정");
export function formatBarLogSummary(log:BarActivityLog,lang:BarLanguage,options:{includeTarget?:boolean}={}){
  const include=options.includeTarget??true;const target=log.entityCode||(log.entityType==="staff_profile"?`#${log.entityId}`:"BAR");const prefix=include?`${target} `:"";const suffix=include?` ${target}`:"";
  const beforePercent=numberValue(log.beforeData,"remaining_percent"),afterPercent=numberValue(log.afterData,"remaining_percent");
  const beforeZone=stringValue(log.beforeData,"zone_code"),afterZone=stringValue(log.afterData,"zone_code");const closeReason=stringValue(log.afterData,"close_reason");
  const customerChanged=stringValue(log.beforeData,"customer_name")!==stringValue(log.afterData,"customer_name");
  const liquorChanged=stringValue(log.beforeData,"liquor_name")!==stringValue(log.afterData,"liquor_name");
  const sourceChanged=stringValue(log.beforeData,"liquor_source")!==stringValue(log.afterData,"liquor_source");
  if(log.actionType==="keeping_remaining_corrected"&&beforePercent!==null&&afterPercent!==null)return lang==="vi"?`Đã chỉnh lượng còn lại ${beforePercent}% → ${afterPercent}%${suffix}.`:`${prefix}잔량을 ${beforePercent}% → ${afterPercent}%로 정정했습니다.`;
  if(log.actionType==="keeping_zone_changed"&&beforeZone&&afterZone)return lang==="vi"?`Đã chuyển vị trí ${beforeZone} → ${afterZone}${suffix}.`:`${prefix}위치를 ${beforeZone} → ${afterZone}로 이동했습니다.`;
  if(log.actionType==="keeping_used"&&afterPercent!==null){const finished=closeReason==="finished";return lang==="vi"?`Đã xử lý sử dụng, còn ${afterPercent}%${finished?" và kết thúc do đã dùng hết":""}${suffix}.`:`${prefix}사용 처리했습니다. 잔량 ${afterPercent}%${finished?", 소진 종료":""}.`;}
  if(log.actionType==="keeping_updated"&&sourceChanged){const before=liquorSourceLabel(stringValue(log.beforeData,"liquor_source"),lang),after=liquorSourceLabel(stringValue(log.afterData,"liquor_source"),lang);return lang==="vi"?`Đã đổi loại rượu ${before} → ${after}${suffix}.`:`${prefix}주류 구분을 ${before} → ${after}으로 변경했습니다.`;}
  if(log.actionType==="keeping_updated"&&(customerChanged||liquorChanged)){const koLabel=customerChanged&&liquorChanged?"고객 정보와 주류명":customerChanged?"고객 정보":"주류명";const viLabel=customerChanged&&liquorChanged?"thông tin khách và tên rượu":customerChanged?"thông tin khách":"tên rượu";return lang==="vi"?`Đã sửa ${viLabel}${suffix}.`:`${prefix}${koLabel}을 수정했습니다.`;}
  const reasonKo:Record<string,string>={finished:"소진",returned:"반출",discarded:"폐기",expired:"만료",other:"기타 종료"};
  const reasonVi:Record<string,string>={finished:"Đã dùng hết",returned:"Đã trả khách",discarded:"Đã hủy",expired:"Hết hạn",other:"Đã kết thúc"};
  const ko:Record<string,string>={zone_content_updated:`${prefix}비고를 수정했습니다.`,zone_assignee_assigned:`${prefix}담당자를 지정했습니다.`,zone_assignee_changed:`${prefix}담당자를 변경했습니다.`,zone_assignee_removed:`${prefix}담당자를 해제했습니다.`,staff_color_changed:`${prefix}담당 색상을 변경했습니다.`,zone_photo_added:`${prefix}사진을 등록했습니다.`,zone_photo_replaced:`${prefix}사진을 교체했습니다.`,zone_photo_removed:`${prefix}사진을 삭제했습니다.`,keeping_created:`${prefix}키핑술을 등록했습니다.`,keeping_updated:`${prefix}키핑 정보를 수정했습니다.`,keeping_photo_replaced:`${prefix}사진을 교체했습니다.`,keeping_closed:`${prefix}${reasonKo[closeReason??""]??"종료"} 처리했습니다.`,keeping_reactivated:`${prefix}키핑을 재활성화했습니다.`};
  const vi:Record<string,string>={zone_content_updated:`Đã sửa ghi chú${suffix}.`,zone_assignee_assigned:`Đã chỉ định người phụ trách${suffix}.`,zone_assignee_changed:`Đã đổi người phụ trách${suffix}.`,zone_assignee_removed:`Đã bỏ người phụ trách${suffix}.`,staff_color_changed:`Đã đổi màu phụ trách${suffix}.`,zone_photo_added:`Đã thêm ảnh${suffix}.`,zone_photo_replaced:`Đã thay ảnh${suffix}.`,zone_photo_removed:`Đã xóa ảnh${suffix}.`,keeping_created:`Đã đăng ký rượu giữ${suffix}.`,keeping_updated:`Đã sửa thông tin giữ rượu${suffix}.`,keeping_photo_replaced:`Đã thay ảnh${suffix}.`,keeping_closed:`${reasonVi[closeReason??""]??"Đã kết thúc"}${suffix}.`,keeping_reactivated:`Đã kích hoạt lại rượu giữ${suffix}.`};
  return (lang==="vi"?vi:ko)[log.actionType]??(lang==="vi"?`Đã thay đổi thông tin${suffix}.`:`${prefix}정보를 변경했습니다.`);
}
export function formatBarDateTime(value:string,lang:BarLanguage,compact=false){const parts=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Ho_Chi_Minh",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(value));const get=(type:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===type)?.value??"";const year=get("year"),month=get("month"),day=get("day"),time=`${get("hour")}:${get("minute")}`;if(compact)return lang==="vi"?`${day}/${month} ${time}`:`${month}/${day} ${time}`;return lang==="vi"?`${day}/${month}/${year} ${time}`:`${year}.${month}.${day} ${time}`;}
