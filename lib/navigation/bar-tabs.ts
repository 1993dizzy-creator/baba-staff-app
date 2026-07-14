export function getBarTabs(pathname: string, lang: "ko" | "vi") {
  return [
    {
      href: "/bar",
      label: lang === "vi" ? "Khu\u00a0vực" : "구역",
      active: pathname === "/bar" || pathname === "/bar/",
    },
    {
      href: "/bar/keeping",
      label: lang === "vi" ? "Giữ\u00a0rượu" : "키핑",
      active: pathname.startsWith("/bar/keeping"),
    },
    {
      href: "/bar/logs",
      label: lang === "vi" ? "Nhật\u00a0ký" : "로그",
      active: pathname.startsWith("/bar/logs"),
    },
  ];
}
