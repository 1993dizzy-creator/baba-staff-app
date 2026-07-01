export const getUser = () => {
  if (typeof window === "undefined") return null;

  const user = localStorage.getItem("baba_user");

  try {
    return user ? JSON.parse(user) : null;
  } catch {
    return null;
  }
};

const getRole = (user = getUser()) => {
  return typeof user?.role === "string" ? user.role.trim().toLowerCase() : "";
};

export const isLoggedIn = () => {
  return !!getUser();
};

export const isMaster = (user = getUser()) => {
  return getRole(user) === "master";
};

export const isAdmin = (user = getUser()) => {
  const role = getRole(user);
  return role === "owner" || role === "master";
};

export const isManage = (user = getUser()) => {
  const role = getRole(user);
  return (
    role === "owner" ||
    role === "master" ||
    role === "manager"
  );
};

export const canAccessAdmin = (user = getUser()) => {
  const role = getRole(user);
  return (
    role === "owner" ||
    role === "master" ||
    role === "manager" ||
    role === "leader"
  );
};

export const canAccessSalesRoot = (user = getUser()) =>
  ["owner", "master", "manager"].includes(getRole(user));

export const canAccessSalesMonthly = (user = getUser()) =>
  ["owner", "master", "manager", "leader"].includes(getRole(user));

export const canAccessSalesReceipts = (user = getUser()) =>
  ["owner", "master", "manager"].includes(getRole(user));

export const canAccessPosMappings = (user = getUser()) =>
  ["owner", "master", "manager", "leader"].includes(getRole(user));

export const canManageUsers = (user = getUser()) =>
  ["owner", "master"].includes(getRole(user));

export const canManageMappingDangerousActions = (user = getUser()) =>
  ["owner", "master", "manager"].includes(getRole(user));
