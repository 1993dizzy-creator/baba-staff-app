// Every non-cancelled deposit (matched history, auto_allocated, or a legacy unmatched/partial
// exception) is one card deposit to the user: a single list by deposit date, then id.
// Cancelled deposits stay visible after it as history.
export function groupCardDeposits<T extends { id: number; deposit_date: string; status: string }>(rows: readonly T[], month: string) {
  const monthly = rows.filter(row => row.deposit_date.slice(0, 7) === month)
    .sort((a, b) => a.deposit_date.localeCompare(b.deposit_date) || a.id - b.id);
  return { deposits: monthly.filter(row => row.status !== "cancelled"), cancelled: monthly.filter(row => row.status === "cancelled") };
}
