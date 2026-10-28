// @ts-expect-error Node's direct TypeScript tests require the explicit extension.
import { selectedLedgerMonth } from "../ledger/month-query.ts";

// month: the current URL's `month`. 대시보드 and 장부작성 share it, so switching tabs keeps
// the selected month; only `month` is carried (no transactionId/inventoryLogId/sourceKey).
// An absent or malformed month is dropped and each page falls back to its default month.
export function getLedgerTabs(pathname: string, lang: "ko" | "vi", month?: string | null) {
  const valid = selectedLedgerMonth(month ?? null, "");
  const withMonth = (href: string) => valid ? `${href}?month=${valid}` : href;
  return [
    {
      href: withMonth("/admin/ledger"),
      label: lang === "vi" ? "Tổng quan" : "대시보드",
      active: pathname === "/admin/ledger" || pathname === "/admin/ledger/",
    },
    {
      href: withMonth("/admin/ledger/entries"),
      label: lang === "vi" ? "Ghi sổ" : "장부작성",
      active: pathname.startsWith("/admin/ledger/entries") || pathname.startsWith("/admin/ledger/card-settlements") || pathname.startsWith("/admin/ledger/owners"),
    },
    {
      href: "/admin/ledger/settings",
      label: lang === "vi" ? "Cài đặt" : "장부설정",
      // Partner detail pages are part of 장부설정 > 거래처.
      active: pathname.startsWith("/admin/ledger/settings") || pathname.startsWith("/admin/partners"),
    },
  ];
}
