import { useState } from "react";

export function useAuth() {
  const [user, setUser] = useState({
    name: "Lakshan Jay",
    role: "Platform Admin",
  });

  return {
    user,
    isAuthenticated: Boolean(user),
    login: setUser,
    logout: () => setUser(null),
  };
}

export default useAuth;
