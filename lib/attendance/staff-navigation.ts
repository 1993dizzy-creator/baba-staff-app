export type StaffDirection = "previous" | "next";

export const SWIPE_INTERACTIVE_SELECTOR = 'button, input, textarea, select, a, label, [role="button"], [role="dialog"], [contenteditable]:not([contenteditable="false"]), [data-no-staff-swipe]';

export function getStaffSwipeDirection(dx: number, dy: number, interactive: boolean): StaffDirection | null {
  if (interactive || Math.abs(dx) < 64 || Math.abs(dx) <= Math.abs(dy) * 1.5) return null;
  return dx < 0 ? "next" : "previous";
}

export function getAdjacentStaffId(ids: readonly number[], currentId: number, direction: StaffDirection): number | null {
  const index = ids.indexOf(currentId);
  if (index < 0) return null;
  return ids[index + (direction === "next" ? 1 : -1)] ?? null;
}

export function getStaffDetailUrl(userId: number | string, month: string, date?: string | null): string {
  const search = new URLSearchParams({ month });
  if (date) search.set("date", date);
  return '/admin/payroll/attendance/' + encodeURIComponent(String(userId)) + '?' + search;
}
