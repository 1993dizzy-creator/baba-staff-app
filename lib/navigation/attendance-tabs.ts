export function getAttendanceTabs(
  pathname: string,
  lang: "ko" | "vi"
) {
  return [
    {
      href: "/attendance",
      label: lang === "vi" ? "Cá nhân" : "내 근태",
      active: pathname === "/attendance" || pathname === "/attendance/",
    },
    {
      href: "/attendance/staff",
      label: lang === "vi" ? "Nhân viên" : "출근 명부",
      active: pathname.startsWith("/attendance/staff"),
    },

    // 🔥 추가
    {
      href: "/attendance/leave",
      label: lang === "vi" ? "Nghỉ phép" : "휴무 관리",
      active: pathname.startsWith("/attendance/leave"),
    },
  ];
}