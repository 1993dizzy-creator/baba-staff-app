export const QUICK_REASON_VALUES = [
  "check",
  "purchase",
  "service",
  "other",
] as const;

export type QuickReasonValue = (typeof QUICK_REASON_VALUES)[number];