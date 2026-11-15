"use client";
// 급여설정은 공통 정책 전용이다. 직원별 급여설정은 직원관리(/admin/users)에서만 관리한다.
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Container from "@/components/Container";
import PayrollCommonSettings from "@/components/payroll/PayrollCommonSettings";
import { useLanguage } from "@/lib/language-context";
import { legacyEmployeeSettingsRedirect } from "@/lib/payroll/employee-settings-href";

export default function PayrollSettingsPage() {
  const { lang } = useLanguage();
  const vi = lang === "vi";
  const params = useSearchParams();
  const router = useRouter();
  // 이전 급여설정 직원 탭 링크는 직원관리의 해당 직원(없으면 목록)으로 바꿔 연다. 공통 설정은 그리지 않아 깜빡임·조회가 없다.
  const legacyRedirect = legacyEmployeeSettingsRedirect(params);
  useEffect(() => {
    if (legacyRedirect) router.replace(legacyRedirect);
  }, [legacyRedirect, router]);
  return (
    <Container noPaddingTop>
      <main style={{ display: "grid", gap: 8, padding: "8px 0 30px", minWidth: 0 }}>
        {legacyRedirect ? null : <PayrollCommonSettings vi={vi} />}
      </main>
    </Container>
  );
}
