export const LEDGER_MANAGER_ROLES = ["owner", "master"] as const;

export function canManageLedger(role: unknown) {
  return role === "owner" || role === "master";
}
