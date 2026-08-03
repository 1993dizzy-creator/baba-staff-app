"use client";

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import EmployeeLevelBadge from "@/components/employee/EmployeeLevelBadge";
import type { EmployeeLevelInfo } from "@/lib/employee-level/types";

const DisabledBadgeContext = createContext(false);

export function EmployeeLevelDisabledBadgeScope({ children }: { children: ReactNode }) {
  return <DisabledBadgeContext.Provider value>{children}</DisabledBadgeContext.Provider>;
}

export default function EmployeeNameWithLevel({
  name,
  levelInfo,
  lang,
  className,
  style,
  nameStyle,
  showDisabledBadge = false,
}: {
  name: string;
  levelInfo?: EmployeeLevelInfo | null;
  lang: "ko" | "vi";
  className?: string;
  style?: CSSProperties;
  nameStyle?: CSSProperties;
  showDisabledBadge?: boolean;
}) {
  const showDisabledFromScope = useContext(DisabledBadgeContext);
  const showLevel = levelInfo?.eligible === true && levelInfo.level !== null;
  const showDisabled = (showDisabledBadge || showDisabledFromScope) && levelInfo?.reason === "PROGRAM_DISABLED";

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: showLevel || showDisabled ? 4 : 0,
        minWidth: 0,
        maxWidth: "100%",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {showLevel || showDisabled ? (
        <EmployeeLevelBadge
          level={showLevel ? levelInfo.level! : null}
          negotiationEligible={levelInfo.negotiationEligible}
          lang={lang}
          disabled={showDisabled}
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
