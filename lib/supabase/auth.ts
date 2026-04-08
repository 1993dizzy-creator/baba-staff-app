export const getUser = () => {
  if (typeof window === "undefined") return null;

  const user = localStorage.getItem("baba_user");
  return user ? JSON.parse(user) : null;
};

export const isLoggedIn = () => {
  return !!getUser();
};