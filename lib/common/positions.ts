export function getPositionRank(position?: string | null) {
  if (!position) return 999;

  const value = position.toLowerCase();

  if (value.includes("manager")) return 1;
  if (value.includes("leader")) return 2;
  if (value.includes("staff")) return 3;

  return 99;
}