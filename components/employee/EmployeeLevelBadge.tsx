import { EMPLOYEE_LEVEL_THEME } from "@/lib/employee-level/presentation";
import type { EmployeeLevel } from "@/lib/employee-level/types";

export default function EmployeeLevelBadge({
  level,
  negotiationEligible,
  lang,
  disabled = false,
}: {
  level: EmployeeLevel | null;
  negotiationEligible: boolean;
  lang: "ko" | "vi";
  disabled?: boolean;
}) {
  const theme = level === null ? null : EMPLOYEE_LEVEL_THEME[level];

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
      <span
        aria-label={disabled
          ? lang === "vi" ? "Không áp dụng cấp nhân viên" : "직원 레벨 미적용"
          : lang === "vi" ? `Cấp nhân viên ${level}` : `직원 레벨 ${level}`}
        style={{
          minWidth: 16,
          height: 16,
          padding: "0 3px",
          boxSizing: "border-box",
          borderRadius: 5,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          background: disabled ? "#f3f4f6" : `linear-gradient(145deg, ${theme!.backgroundColor}, ${theme!.borderColor})`,
          color: disabled ? "#374151" : theme!.textColor,
          border: `1px solid ${disabled ? "#9ca3af" : theme!.borderColor}`,
          boxShadow: "0 1px 1px rgba(15, 23, 42, 0.08)",
          fontSize: 9,
          fontWeight: 800,
          lineHeight: 1,
        }}
      >
        {disabled ? "X" : theme!.shortLabel}
      </span>
      {!disabled && negotiationEligible ? (
        <span aria-hidden="true" style={{ color: "#ca8a04", fontSize: 10 }}>
          ★
        </span>
      ) : null}
    </span>
  );
}
