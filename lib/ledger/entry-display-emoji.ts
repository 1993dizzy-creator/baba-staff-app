export function chooseLedgerEntryEmoji(
  partnerEmoji: string | null | undefined,
  ledgerCategoryEmoji: string,
) {
  return partnerEmoji || ledgerCategoryEmoji;
}