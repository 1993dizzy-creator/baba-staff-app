"use client";

import { usePathname } from "next/navigation";
import SubNav from "@/components/SubNav";
import { useLanguage } from "@/lib/language-context";
import { getPayrollTabs } from "@/lib/navigation/payroll-tabs";

const wrapperStyle = {
  maxWidth: 800,
  margin: "0 auto",
  padding: "0 16px",
};

export default function PayrollSubNav() {
  const pathname = usePathname();
  const { lang } = useLanguage();

  return (
    <div style={wrapperStyle}>
      <SubNav tabs={getPayrollTabs(pathname, lang)} />
    </div>
  );
}
