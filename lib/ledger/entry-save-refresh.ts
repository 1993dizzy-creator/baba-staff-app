// Refresh only data a completed edit can change. All monetary values still
// come from the existing ledger/payables APIs; no client-side rebooking.
export async function readEditedLedger<Ledger extends { month: string }, Payables extends { month: string }>(
  month: string,
  financial: boolean,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<{ ledger: Ledger; payables: Payables | null }> {
  const [ledgerResponse, payableResponse] = await Promise.all([
    fetcher(`/api/admin/ledger?month=${month}`, { cache: "no-store", signal }),
    financial ? fetcher(`/api/admin/ledger/payables?month=${month}`, { cache: "no-store", signal }) : null,
  ]);
  const [ledger, payables] = await Promise.all([
    ledgerResponse.json(), payableResponse?.json() ?? null,
  ]);
  if (!ledgerResponse.ok || (payableResponse && !payableResponse.ok) ||
      ledger?.month !== month || (payables && payables.month !== month)) {
    throw new Error("LEDGER_REFRESH_FAILED");
  }
  return { ledger: ledger as Ledger, payables: payables as Payables | null };
}
