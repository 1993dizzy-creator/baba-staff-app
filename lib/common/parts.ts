export const PART_VALUES = ["kitchen", "hall", "bar", "etc"] as const;

export type PartValue = (typeof PART_VALUES)[number];

export const PART_META: Record<
  PartValue,
  {
    label: string;
    color: string;
    soft: string;
    bg: string;
    border: string;
    emoji: string;
    rank: number;
  }
> = {
  kitchen: {
    label: "Kitchen",
    color: "#f59e0b",
    soft: "#fff7ed",
    bg: "#fff7ed",
    border: "#f59e0b",
    emoji: "🍳",
    rank: 1,
  },
  hall: {
    label: "Hall",
    color: "#10b981",
    soft: "#ecfdf5",
    bg: "#ecfdf5",
    border: "#10b981",
    emoji: "🍺",
    rank: 2,
  },
  bar: {
    label: "Bar",
    color: "#3b82f6",
    soft: "#eff6ff",
    bg: "#eff6ff",
    border: "#3b82f6",
    emoji: "🍸",
    rank: 3,
  },
  etc: {
    label: "Etc",
    color: "#8b5cf6",
    soft: "#f5f3ff",
    bg: "#f5f3ff",
    border: "#8b5cf6",
    emoji: "📦",
    rank: 99,
  },
};