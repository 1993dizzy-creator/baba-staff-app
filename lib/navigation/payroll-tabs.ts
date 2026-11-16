import { isPayrollRunPath, withPayrollMonth } from "../payroll/payroll-month-param.ts";

// month: 현재 화면의 선택 월(URL ?month). 세 탭 모두 같은 월을 이어받는다.
export function getPayrollTabs(pathname: string, lang: "ko" | "vi", month?: string | null) {
  return [
    {
      href: withPayrollMonth("/admin/payroll/attendance", month),
      label: lang === "vi" ? "Chấm công" : "근태현황",
      active: pathname.startsWith("/admin/payroll/attendance"),
    },
    {
      href: withPayrollMonth("/admin/payroll", month),
      label: lang === "vi" ? "Tiền lương" : "급여관리",
      active: pathname === "/admin/payroll" || pathname === "/admin/payroll/" || isPayrollRunPath(pathname),
    },
    {
      href: withPayrollMonth("/admin/payroll/settings", month),
      label: lang === "vi" ? "Cài đặt lương" : "급여설정",
      active: pathname.startsWith("/admin/payroll/settings"),
    },
  ];
}
