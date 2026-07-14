import type { BarActivityLog } from "@/lib/bar/types";

export type BarLanguage = "ko" | "vi";

export function formatBarLogSummary(log: BarActivityLog, lang: BarLanguage, options: { includeTarget?: boolean } = {}) {
  const includeTarget = options.includeTarget ?? true;
  const target = log.entityCode || (log.entityType === "staff_profile" ? `#${log.entityId}` : "BAR");
  const targetKo = includeTarget ? `${target} ` : "";
  const ko: Record<string, string> = {
    zone_content_updated: `${targetKo}비고를 수정했습니다.`, zone_assignee_assigned: `${targetKo}담당자를 지정했습니다.`,
    zone_assignee_changed: `${targetKo}담당자를 변경했습니다.`, zone_assignee_removed: `${targetKo}담당자를 해제했습니다.`,
    staff_color_changed: `${targetKo}담당 색상을 변경했습니다.`, zone_photo_added: `${targetKo}사진을 등록했습니다.`,
    zone_photo_replaced: `${targetKo}사진을 교체했습니다.`, zone_photo_removed: `${targetKo}사진을 삭제했습니다.`,
  };
  const suffix = includeTarget ? ` ${target}` : "";
  const vi: Record<string, string> = {
    zone_content_updated: `Đã sửa ghi chú${suffix}.`, zone_assignee_assigned: `Đã chỉ định người phụ trách${suffix}.`,
    zone_assignee_changed: `Đã đổi người phụ trách${suffix}.`, zone_assignee_removed: `Đã bỏ người phụ trách${suffix}.`,
    staff_color_changed: `Đã đổi màu phụ trách${suffix}.`, zone_photo_added: `Đã thêm ảnh${suffix}.`,
    zone_photo_replaced: `Đã thay ảnh${suffix}.`, zone_photo_removed: `Đã xóa ảnh${suffix}.`,
  };
  return (lang === "vi" ? vi : ko)[log.actionType]
    ?? (lang === "vi" ? `Đã thay đổi${suffix}.` : `${targetKo}정보를 변경했습니다.`);
}

export function formatBarDateTime(value: string, lang: BarLanguage, compact = false) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year"); const month = get("month"); const day = get("day");
  const time = `${get("hour")}:${get("minute")}`;
  if (compact) return lang === "vi" ? `${day}/${month} ${time}` : `${month}/${day} ${time}`;
  return lang === "vi" ? `${day}/${month}/${year} ${time}` : `${year}.${month}.${day} ${time}`;
}
