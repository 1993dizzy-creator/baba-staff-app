export const BAR_COLOR_KEYS = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;

export type BarColorKey = (typeof BAR_COLOR_KEYS)[number];

export const BAR_COLORS: Record<
  BarColorKey,
  { labelKo: string; labelVi: string; css: string }
> = {
  red: { labelKo: "빨강", labelVi: "Đỏ", css: "#f87171" },
  orange: { labelKo: "주황", labelVi: "Cam", css: "#fb923c" },
  yellow: { labelKo: "노랑", labelVi: "Vàng", css: "#facc15" },
  green: { labelKo: "초록", labelVi: "Xanh lá", css: "#4ade80" },
  teal: { labelKo: "청록", labelVi: "Xanh ngọc", css: "#2dd4bf" },
  blue: { labelKo: "파랑", labelVi: "Xanh dương", css: "#60a5fa" },
  purple: { labelKo: "보라", labelVi: "Tím", css: "#c084fc" },
  pink: { labelKo: "분홍", labelVi: "Hồng", css: "#f472b6" },
};

export const isBarColorKey = (value: unknown): value is BarColorKey =>
  typeof value === "string" && BAR_COLOR_KEYS.includes(value as BarColorKey);
