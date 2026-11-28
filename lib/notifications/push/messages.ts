// Lock-screen text for Web Push (01-B). Only fixed, generic KO/VI wording plus the type's generic
// name: never the event title/body, staff names, amounts, customers or receipt details. The
// payload is built from the type code and notification id alone, so sensitive event text cannot
// reach a lock screen even when a business writer puts it in the in-app body.

export const PUSH_PAYLOAD_VERSION = 1 as const;

const TYPE_NAMES: Record<string, { ko: string; vi: string }> = {
  "attendance.leave_request_pending": { ko: "휴무 신청 대기", vi: "Đơn nghỉ chờ duyệt" },
  "inventory.pos_deduction_pending": { ko: "POS 재고 미차감", vi: "POS chưa trừ kho" },
};

export type PushPayload = {
  v: typeof PUSH_PAYLOAD_VERSION;
  tag: string;
  title: string;
  body: string;
  url: string;
  badge: number | null;
};

export function buildPushPayload(input: {
  notificationId: number; typeCode: string; lang: "ko" | "vi" | string; unreadCount?: number | null;
}): PushPayload {
  const lang = input.lang === "vi" ? "vi" : "ko";
  const name = TYPE_NAMES[input.typeCode]?.[lang];
  const title = lang === "vi" ? "Thông báo BABA" : "BABA 알림";
  const body = lang === "vi"
    ? (name ? `Có thông báo công việc mới: ${name}` : "Có thông báo công việc mới. Mở ứng dụng để xem.")
    : (name ? `새 업무 알림이 있습니다: ${name}` : "새 업무 알림이 있습니다. 앱에서 확인해주세요.");
  const badge = typeof input.unreadCount === "number" && Number.isSafeInteger(input.unreadCount) && input.unreadCount >= 0
    ? Math.min(input.unreadCount, 100) : null;
  return {
    v: PUSH_PAYLOAD_VERSION,
    tag: `baba-n-${input.notificationId}`,
    title,
    body,
    url: `/notifications/open?id=${input.notificationId}`,
    badge,
  };
}

/** Push service Topic (<= 32 URL-safe chars): a newer message for the same event replaces a queued one. */
export const pushTopic = (notificationId: number) => `n${notificationId}`;
