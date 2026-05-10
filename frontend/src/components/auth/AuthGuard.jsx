import { useAuthContext } from "../../context/AuthContext";

/**
 * AuthGuard — renders children only when authenticated.
 * In App.jsx the entire app is already gated, so this is a
 * belt-and-suspenders guard for individual components if needed.
 */
function AuthGuard({ children, fallback = null }) {
  const { isAuthenticated } = useAuthContext();
  return isAuthenticated ? children : fallback;
}

export default AuthGuard;
