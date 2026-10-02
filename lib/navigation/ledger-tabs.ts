export function getLedgerTabs(pathname: string, lang: "ko" | "vi") {
  return [
    {
      href: "/admin/ledger",
      label: lang === "vi" ? "Tổng quan" : "대시보드",
      active: pathname === "/admin/ledger" || pathname === "/admin/ledger/",
    },
    {
      href: "/admin/ledger/entries",
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
