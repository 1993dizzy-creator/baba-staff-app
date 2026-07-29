import type { CSSProperties } from "react";
import EmployeeLevelBadge from "@/components/employee/EmployeeLevelBadge";
import type { EmployeeLevelInfo } from "@/lib/employee-level/types";

export default function EmployeeNameWithLevel({
  name,
  levelInfo,
  lang,
  className,
  style,
  nameStyle,
}: {
  name: string;
  levelInfo?: EmployeeLevelInfo | null;
  lang: "ko" | "vi";
  className?: string;
  style?: CSSProperties;
  nameStyle?: CSSProperties;
}) {
  const showLevel = levelInfo?.eligible === true && levelInfo.level !== null;

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: showLevel ? 4 : 0,
        minWidth: 0,
        maxWidth: "100%",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {showLevel ? (
        <EmployeeLevelBadge
          level={levelInfo.level!}
          negotiationEligible={levelInfo.negotiationEligible}
          lang={lang}
        />
      ) : null}
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          ...nameStyle,
        }}
      >
        {name}
      </span>
    </span>
  );
}
