export function getInventoryTabs(
  pathname: string,
  lang: "ko" | "vi"
) {
  return [
    {
      href: "/inventory",
      label: lang === "vi" ? "Tồn kho" : "재고관리",
      active: pathname === "/inventory" || pathname === "/inventory/",
    },
    {
      href: "/inventory/logs",
      label: lang === "vi" ? "Log" : "재고로그",
      active: pathname.startsWith("/inventory/logs"),
    },
    {
      href: "/inventory/snapshots",
      label: lang === "vi" ? "Theo ngày" : "일자별재고",
      active: pathname.startsWith("/inventory/snapshots"),
    },
  ];
}