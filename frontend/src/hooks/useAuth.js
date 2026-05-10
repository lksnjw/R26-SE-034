/**
 * useAuth — thin wrapper around AuthContext for components
 * that only need user/isAuthenticated without the full context.
 */
import { useAuthContext } from "../context/AuthContext";

export function useAuth() {
  return useAuthContext();
}

export default useAuth;
