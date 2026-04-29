import { getUser, isAdmin } from "@/lib/supabase/auth";

export function getAttendanceTabs(
  pathname: string,
  lang: "ko" | "vi"
) {
  const user = getUser();
  const isAdminUser = isAdmin(user);

  return [
    {
      href: isAdminUser ? "/attendance/overview" : "/attendance",
      label: isAdminUser
        ? lang === "vi" ? "Tổng quan" : "전체현황"
        : lang === "vi" ? "Cá nhân" : "내 근태",
      active: isAdminUser
        ? pathname.startsWith("/attendance/overview")
        : pathname === "/attendance" || pathname === "/attendance/",
    },
    {
      href: "/attendance/staff",
      label: lang === "vi" ? "Nhân viên" : "출근 명부",
      active: pathname.startsWith("/attendance/staff"),
    },
    {
      href: "/attendance/leave",
      label: lang === "vi" ? "Nghỉ phép" : "휴무 관리",
      active: pathname.startsWith("/attendance/leave"),
    },
  ];
}