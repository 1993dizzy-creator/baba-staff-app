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
          minWidth: 18,
          height: 18,
          padding: "0 4px",
          boxSizing: "border-box",
          borderRadius: 6,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          background: `linear-gradient(145deg, ${theme.backgroundColor}, ${theme.borderColor})`,
          color: theme.textColor,
          border: `1px solid ${theme.borderColor}`,
          boxShadow: "0 1px 2px rgba(15, 23, 42, 0.12)",
          fontSize: 10,
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
