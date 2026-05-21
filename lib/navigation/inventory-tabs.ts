export function getInventoryTabs(pathname: string, lang: "ko" | "vi") {
  return [
    {
      href: "/inventory",
      label: lang === "vi" ? "Quản lý kho" : "재고관리",
      active: pathname === "/inventory" || pathname === "/inventory/",
    },
    {
      href: "/inventory/snapshots",
      label: lang === "vi" ? "Ngày" : "일자별재고",
      active: pathname.startsWith("/inventory/snapshots"),
    },
    {
      href: "/inventory/monthly",
      label: lang === "vi" ? "Tháng" : "월간현황",
      active: pathname.startsWith("/inventory/monthly"),
    },
  ];
}
