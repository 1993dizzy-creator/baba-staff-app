export function formatRecognizedWork(
  recognizedMinutes: number,
  recognizedWorkdays: number,
  lang: "ko" | "vi",
) {
  const minutes = Math.max(0, Math.trunc(recognizedMinutes));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const time = lang === "vi"
    ? hours > 0
      ? `${hours} giờ${remainingMinutes > 0 ? ` ${remainingMinutes} phút` : ""}`
      : minutes > 0 ? `${minutes} phút` : "0 giờ"
    : hours > 0
      ? `${hours}시간${remainingMinutes > 0 ? ` ${remainingMinutes}분` : ""}`
      : minutes > 0 ? `${minutes}분` : "0시간";
  const days = new Intl.NumberFormat(lang === "vi" ? "vi-VN" : "en-US", {
    maximumFractionDigits: 2,
  }).format(Number(recognizedWorkdays.toFixed(2)));

  return `${time} (${days}${lang === "vi" ? " ngày" : "일"})`;
}

type PayrollHeaderEmployee = {
  contract: unknown | null;
  amounts: {
    combinedSalary: number | null;
    contractMonthlyEquivalent: number | null;
  };
};

export function getPayrollHeaderAmount(
  employee: PayrollHeaderEmployee,
  future = false,
) {
  if (future || !employee.contract || employee.amounts.combinedSalary === null) {
    return null;
  }
  return employee.amounts.contractMonthlyEquivalent
    ?? employee.amounts.combinedSalary;
}

export function sortPayrollEmployeesByHeaderAmount<T extends PayrollHeaderEmployee>(
  employees: readonly T[],
  future = false,
) {
  return employees
    .map((employee, index) => ({
      employee,
      index,
      amount: getPayrollHeaderAmount(employee, future),
    }))
    .sort((a, b) => {
      if (a.amount === null) return b.amount === null ? a.index - b.index : 1;
      if (b.amount === null) return -1;
      return b.amount - a.amount || a.index - b.index;
    })
    .map(({ employee }) => employee);
}
