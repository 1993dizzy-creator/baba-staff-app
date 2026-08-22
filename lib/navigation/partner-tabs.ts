export function getPartnerTabs(pathname: string, lang: "ko" | "vi") {
  return [
    {
      href: "/admin/partners",
      label: lang === "vi" ? "Đăng ký" : "등록",
      active:
        pathname === "/admin/partners" ||
        pathname === "/admin/partners/" ||
        pathname.startsWith("/admin/partners/candidates/"),
    },
    {
      href: "/admin/partners/info",
      label: lang === "vi" ? "Thông tin" : "정보",
      active:
        pathname === "/admin/partners/info" ||
        pathname.startsWith("/admin/partners/info/") ||
        /^\/admin\/partners\/\d+\/?$/.test(pathname),
    },
  ];
}
