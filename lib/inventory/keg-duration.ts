/**
 * Formats the gap between a closed keg session's startedAt/endedAt as a
 * short human-readable duration (not a date range) — floor-based, matching
 * the existing keg-progress "elapsed days" convention of not rounding up.
 */
export function formatKegSessionDuration(
  startedAt: string | null,
  endedAt: string | null,
  lang: "ko" | "vi"
): string | null {
  if (!startedAt || !endedAt) return null;

  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const totalMinutes = Math.floor(Math.max(0, endMs - startMs) / 60000);

  if (totalMinutes < 1) {
    return lang === "vi" ? "Dưới 1 phút" : "1분 미만";
  }

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days >= 1) {
    if (hours < 1) {
      return lang === "vi" ? `${days} ngày` : `${days}일`;
    }
    return lang === "vi" ? `${days} ngày ${hours} giờ` : `${days}일 ${hours}시간`;
  }

  if (hours >= 1) {
    if (minutes < 1) {
      return lang === "vi" ? `${hours} giờ` : `${hours}시간`;
    }
    return lang === "vi" ? `${hours} giờ ${minutes} phút` : `${hours}시간 ${minutes}분`;
  }

  return lang === "vi" ? `${minutes} phút` : `${minutes}분`;
}
