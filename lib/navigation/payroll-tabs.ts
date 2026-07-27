export function getPayrollTabs(pathname: string, lang: "ko" | "vi") {
  return [
    {
      href: "/admin/payroll/attendance",
      label: lang === "vi" ? "Chấm công" : "근태현황",
      active: pathname.startsWith("/admin/payroll/attendance"),
    },
    {
      href: "/admin/payroll",
      label: lang === "vi" ? "Tiền lương" : "급여관리",
      active: pathname === "/admin/payroll" || pathname === "/admin/payroll/",
    },
    {
      href: "/admin/payroll/settings",
      label: lang === "vi" ? "Cài đặt lương" : "급여설정",
      active: pathname.startsWith("/admin/payroll/settings"),
    },
  ];
}
