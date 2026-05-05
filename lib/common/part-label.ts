import { PartValue } from "@/lib/common/parts";

export function getPartLabel(
  part: string | null | undefined,
  t?: any
) {
  if (!t) return part || "-";

  switch (part as any) {
    case "kitchen":
      return t.partKitchen || t.kitchen;
    case "hall":
      return t.partHall || t.hall;
    case "bar":
      return t.partBar || t.bar;
    case "etc":
      return t.partEtc || t.etc;
    default:
      return part || "-";
  }
}