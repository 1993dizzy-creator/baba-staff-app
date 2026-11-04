// /admin/payroll?month=YYYY-MM 파라미터 해석. 형식·범위가 올바른 월만 받아들이고, 그 외(없음·잘못된 값)는 null을
// 돌려 호출부가 기존 기본 월(현재 베트남 월)을 쓰게 한다.
export function parsePayrollMonthParam(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}`;
}

// 지급장부(run.payroll_month, 예: "2026-09-01")에서 급여관리로 돌아갈 주소. 월을 알 수 없으면 기본 주소.
export function payrollOverviewHref(payrollMonth: string | null | undefined): string {
  const month = parsePayrollMonthParam(typeof payrollMonth === "string" ? payrollMonth.slice(0, 7) : null);
  return month ? `/admin/payroll?month=${month}` : "/admin/payroll";
}
