import type { EmployeeLevelInfo } from "./types";

export function formatEmployeeNameWithLevel(
  name: string,
  levelInfo?: EmployeeLevelInfo | null
) {
  if (levelInfo?.eligible !== true || levelInfo.level === null) return name;
  const star = levelInfo.negotiationEligible ? "★" : "";
  return `Lv.${levelInfo.level}${star} · ${name}`;
}
