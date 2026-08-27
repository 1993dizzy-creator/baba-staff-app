export function mealCandidateSyncMonths(effectiveFrom: string, currentMonth: string) {
  const first = effectiveFrom.slice(0, 7);
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (!validMonth.test(first) || !validMonth.test(currentMonth) || first > currentMonth) return [];

  const months: string[] = [];
  for (let month = first; month <= currentMonth;) {
    months.push(month);
    const next = new Date(`${month}-01T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    month = next.toISOString().slice(0, 7);
  }
  return months;
}
