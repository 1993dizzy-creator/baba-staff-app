import type { EmployeeLevel } from "./types";

export type EmployeeLevelPresentation = {
  level: EmployeeLevel;
  label: string;
  shortLabel: string;
  backgroundColor: string;
  textColor: string;
  borderColor: string;
};

export const EMPLOYEE_LEVEL_THEME: Record<
  EmployeeLevel,
  EmployeeLevelPresentation
> = {
  0: { level: 0, label: "Lv.0", shortLabel: "0", backgroundColor: "#94A3B8", textColor: "#FFFFFF", borderColor: "#64748B" },
  1: { level: 1, label: "Lv.1", shortLabel: "1", backgroundColor: "#EF4444", textColor: "#FFFFFF", borderColor: "#DC2626" },
  2: { level: 2, label: "Lv.2", shortLabel: "2", backgroundColor: "#F97316", textColor: "#FFFFFF", borderColor: "#EA580C" },
  3: { level: 3, label: "Lv.3", shortLabel: "3", backgroundColor: "#FACC15", textColor: "#FFFFFF", borderColor: "#EAB308" },
  4: { level: 4, label: "Lv.4", shortLabel: "4", backgroundColor: "#22C55E", textColor: "#FFFFFF", borderColor: "#16A34A" },
  5: { level: 5, label: "Lv.5", shortLabel: "5", backgroundColor: "#3B82F6", textColor: "#FFFFFF", borderColor: "#2563EB" },
  6: { level: 6, label: "Lv.6", shortLabel: "6", backgroundColor: "#4F46E5", textColor: "#FFFFFF", borderColor: "#4338CA" },
  7: { level: 7, label: "Lv.7", shortLabel: "7", backgroundColor: "#A855F7", textColor: "#FFFFFF", borderColor: "#9333EA" },
};
