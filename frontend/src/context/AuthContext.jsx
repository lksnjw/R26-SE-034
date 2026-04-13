import { createContext, useContext, useMemo, useState } from "react";

const AuthContext = createContext(null);

const initialUser = {
  id: "usr_admin",
  name: "Lakshan Jay",
  email: "admin@workflow.local",
  role: "Platform Admin",
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(initialUser);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      login: () => setUser(initialUser),
      logout: () => setUser(null),
    }),
    [user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuthContext must be used within AuthProvider");
  }
  return context;
}
