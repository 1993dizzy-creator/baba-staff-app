export type BarPermissionUser = {
  role?: unknown;
  part?: unknown;
  is_active?: unknown;
} | null;

export const normalizeBarPermissionValue = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const isActive = (user: BarPermissionUser) => user?.is_active === true;
const isOwnerOrMaster = (user: BarPermissionUser) =>
  ["owner", "master"].includes(normalizeBarPermissionValue(user?.role));
const isBarRole = (user: BarPermissionUser, roles: string[]) =>
  normalizeBarPermissionValue(user?.part) === "bar" && roles.includes(normalizeBarPermissionValue(user?.role));

export const canViewBar = (user: BarPermissionUser) => isActive(user);

export const canEditBarZone = (user: BarPermissionUser) =>
  isActive(user) &&
  (isOwnerOrMaster(user) || isBarRole(user, ["leader", "staff"]));

export const canAssignBarZone = (user: BarPermissionUser) =>
  isActive(user) &&
  (isOwnerOrMaster(user) || isBarRole(user, ["leader"]));

export const canViewBarLogs = (user: BarPermissionUser) => isActive(user);
