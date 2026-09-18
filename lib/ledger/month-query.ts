const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function selectedLedgerMonth(requested: string | null, fallback: string) {
  return requested && MONTH.test(requested) ? requested : fallback;
}

export function ledgerMonthHref(pathname: string, search: string, month: string) {
  if (!MONTH.test(month)) throw new Error("INVALID_MONTH");
  const params = new URLSearchParams(search);
  params.set("month", month);
  return `${pathname}?${params.toString()}`;
}
