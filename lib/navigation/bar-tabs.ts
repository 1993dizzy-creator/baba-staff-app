export function getBarTabs(pathname: string, lang: "ko" | "vi") {
  return [
    {
      href: "/bar",
      label: lang === "vi" ? "Thông tin khu vực" : "구역정보",
      active: pathname === "/bar" || pathname === "/bar/",
    },
    {
      href: "/bar/keeping",
      label: lang === "vi" ? "Giữ rượu" : "키핑",
      active: pathname.startsWith("/bar/keeping"),
    },
    {
      href: "/bar/logs",
      label: lang === "vi" ? "Nhật ký" : "로그",
      active: pathname.startsWith("/bar/logs"),
    },
  ];
}
