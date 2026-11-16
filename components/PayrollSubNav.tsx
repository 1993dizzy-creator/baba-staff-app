"use client";

import { usePathname, useSearchParams } from "next/navigation";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getPayrollTabs } from "@/lib/navigation/payroll-tabs";
import { parsePayrollMonthParam } from "@/lib/payroll/payroll-month-param";

const wrapperStyle = {
  maxWidth: 800,
  margin: "0 auto",
  padding: "0 16px",
};

// 선택 월은 각 화면이 URL ?month=YYYY-MM으로 동기화하고, 탭 이동 시 그대로 이어받는다.
// (지급장부 상세는 배치의 실제 급여월을 URL에 맞춰 둔다.)
export default function PayrollSubNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { lang } = useLanguage();
  const month = parsePayrollMonthParam(searchParams.get("month"));

  return (
    <div style={wrapperStyle}>
      <SubNav tabs={getPayrollTabs(pathname, lang, month)} />
    </div>
  );
}
