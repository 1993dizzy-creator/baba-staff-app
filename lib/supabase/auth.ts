export const getUser = () => {
  if (typeof window === "undefined") return null;

  const user = localStorage.getItem("baba_user");

  try {
    return user ? JSON.parse(user) : null;
  } catch {
    return null;
  }
};

export const isLoggedIn = () => {
  return !!getUser();
};

export const isMaster = (user = getUser()) => {
  return user?.role === "master";
};

export const isAdmin = (user = getUser()) => {
  return user?.role === "owner" || user?.role === "master";
};