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
  1: { level: 1, label: "Lv.1", shortLabel: "1", backgroundColor: "#0369A1", textColor: "#FFFFFF", borderColor: "#075985" },
  2: { level: 2, label: "Lv.2", shortLabel: "2", backgroundColor: "#0E7490", textColor: "#FFFFFF", borderColor: "#155E75" },
  3: { level: 3, label: "Lv.3", shortLabel: "3", backgroundColor: "#0F766E", textColor: "#FFFFFF", borderColor: "#115E59" },
  4: { level: 4, label: "Lv.4", shortLabel: "4", backgroundColor: "#15803D", textColor: "#FFFFFF", borderColor: "#166534" },
  5: { level: 5, label: "Lv.5", shortLabel: "5", backgroundColor: "#A16207", textColor: "#FFFFFF", borderColor: "#854D0E" },
  6: { level: 6, label: "Lv.6", shortLabel: "6", backgroundColor: "#C2410C", textColor: "#FFFFFF", borderColor: "#9A3412" },
  7: { level: 7, label: "Lv.7", shortLabel: "7", backgroundColor: "#BE123C", textColor: "#FFFFFF", borderColor: "#9F1239" },
  8: { level: 8, label: "Lv.8", shortLabel: "8", backgroundColor: "#6D28D9", textColor: "#FFFFFF", borderColor: "#5B21B6" },
};
