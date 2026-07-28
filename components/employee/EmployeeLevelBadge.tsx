import { EMPLOYEE_LEVEL_THEME } from "@/lib/employee-level/presentation";
import type { EmployeeLevel } from "@/lib/employee-level/types";

export default function EmployeeLevelBadge({
  level,
  negotiationEligible,
  lang,
}: {
  level: EmployeeLevel;
  negotiationEligible: boolean;
  lang: "ko" | "vi";
}) {
  const theme = EMPLOYEE_LEVEL_THEME[level];

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
      <span
        aria-label={lang === "vi" ? `Cấp nhân viên ${level}` : `직원 레벨 ${level}`}
        style={{
          width: 24,
          height: 24,
          borderRadius: 8,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          backgroundColor: theme.backgroundColor,
          color: theme.textColor,
          border: `1px solid ${theme.borderColor}`,
          fontSize: 12,
          fontWeight: 800,
          lineHeight: 1,
        }}
      >
        {theme.shortLabel}
      </span>
      {negotiationEligible ? (
        <span aria-hidden="true" style={{ color: "#a16207", fontSize: 11 }}>
          ★
        </span>
      ) : null}
    </span>
  );
}
