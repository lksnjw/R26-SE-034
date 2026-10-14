import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AUTH_STORAGE, clearStoredSession, getRefreshInFlight, isServerUnavailable } from "../config/axios";
import { authService } from "../services/auth.service";
import { beginAuthorityTransition, captureAuthority, isAuthorityCurrent, staleAuthorityError, transitionAuthority } from "../utils/authAuthority";

const AuthContext = createContext(null);
const LEGACY_HANDOFFS = ["workflow.pendingChatEdit", "workflow.pendingCanvasWorkflow"];

function loadStoredUser() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE.user);
    const user = raw ? JSON.parse(raw) : null;
    transitionAuthority(user);
    return user;
  } catch {
    transitionAuthority(null);
    return null;
  }
}

function clearTransitionData(queryClient) {
  void queryClient.cancelQueries();
  queryClient.clear();
  LEGACY_HANDOFFS.forEach(key => localStorage.removeItem(key));
}

async function loadCurrentUser(capture) {
  const refreshInFlight = getRefreshInFlight();
  if (refreshInFlight?.epoch === capture.epoch) await refreshInFlight;
  if (!isAuthorityCurrent(capture)) return null;
  return authService.me({ isCurrent: () => isAuthorityCurrent(capture) });
}

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState(loadStoredUser);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [serverUnreachable, setServerUnreachable] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const currentCapture = useMemo(() => captureAuthority(user), [user]);

  const applyAuthority = useCallback(nextUser => {
    const after = transitionAuthority(nextUser);
    if (after.changed) {
      clearTransitionData(queryClient);
      setAuthError("");
      setServerUnreachable(false);
    }
    setUser(nextUser);
    if (nextUser) localStorage.setItem(AUTH_STORAGE.user, JSON.stringify(nextUser));
    else localStorage.removeItem(AUTH_STORAGE.user);
    return after;
  }, [queryClient]);

  // Revalidate on mount and explicit reconnect only. Auth changes themselves
  // go through the guarded login/register/refresh transitions below.
  useEffect(() => {
    if (!localStorage.getItem(AUTH_STORAGE.token)) return undefined;
    const capture = captureAuthority(user);
    let cancelled = false;
    loadCurrentUser(capture).then(me => {
      if (!me) return;
      if (cancelled || !isAuthorityCurrent(capture)) return;
      applyAuthority(me);
      setServerUnreachable(false);
    }).catch(error => {
      if (cancelled || !isAuthorityCurrent(capture)) return;
      if (isServerUnavailable(error)) setServerUnreachable(true);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectNonce]);

  useEffect(() => {
    const handleExpired = () => {
      beginAuthorityTransition();
      clearStoredSession();
      clearTransitionData(queryClient);
      setUser(null);
      setAuthError("");
      setServerUnreachable(false);
    };
    const handleUnreachable = () => setServerUnreachable(true);
    window.addEventListener("auth:expired", handleExpired);
    window.addEventListener("auth:unreachable", handleUnreachable);
    return () => {
      window.removeEventListener("auth:expired", handleExpired);
      window.removeEventListener("auth:unreachable", handleUnreachable);
    };
  }, [queryClient]);

  const retryConnection = useCallback(() => setReconnectNonce(value => value + 1), []);

  const login = useCallback(async credentials => {
    const fence = beginAuthorityTransition();
    clearStoredSession();
    clearTransitionData(queryClient);
    setUser(null);
    setLoading(true);
    setAuthError("");
    try {
      const session = await authService.login(credentials, { isCurrent: () => isAuthorityCurrent(fence) });
      if (!isAuthorityCurrent(fence)) throw staleAuthorityError();
      applyAuthority(session.user ?? session);
      setServerUnreachable(false);
      setLoading(false);
      return session;
    } catch (err) {
      if (isAuthorityCurrent(fence)) setAuthError(err?.response?.data?.message ?? "Login failed. Please check your credentials.");
      throw err;
    } finally {
      if (isAuthorityCurrent(fence)) setLoading(false);
    }
  }, [applyAuthority, queryClient]);

  const register = useCallback(async payload => {
    const fence = beginAuthorityTransition();
    clearStoredSession();
    clearTransitionData(queryClient);
    setUser(null);
    setLoading(true);
    setAuthError("");
    try {
      const session = await authService.register(payload, { isCurrent: () => isAuthorityCurrent(fence) });
      if (!isAuthorityCurrent(fence)) throw staleAuthorityError();
      applyAuthority(session.user ?? session);
      setServerUnreachable(false);
      setLoading(false);
      return session;
    } catch (err) {
      if (isAuthorityCurrent(fence)) setAuthError(err?.response?.data?.message ?? "Registration failed. Please try again.");
      throw err;
    } finally {
      if (isAuthorityCurrent(fence)) setLoading(false);
    }
  }, [applyAuthority, queryClient]);

  const logout = useCallback(async () => {
    if (!isAuthorityCurrent(currentCapture)) throw staleAuthorityError();
    const accessToken = localStorage.getItem(AUTH_STORAGE.token);
    const refreshToken = localStorage.getItem(AUTH_STORAGE.refresh);
    const fence = beginAuthorityTransition();
    clearStoredSession();
    clearTransitionData(queryClient);
    setUser(null);
    setAuthError("");
    setLoading(false);
    await authService.logout({ isCurrent: () => isAuthorityCurrent(fence), accessToken, refreshToken });
  }, [currentCapture, queryClient]);

  const refreshUser = useCallback(async () => {
    const fence = currentCapture;
    const me = await authService.me({ isCurrent: () => isAuthorityCurrent(fence) });
    if (!isAuthorityCurrent(fence)) throw staleAuthorityError();
    applyAuthority(me);
    return me;
  }, [applyAuthority, currentCapture]);

  const clearError = useCallback(() => setAuthError(""), []);
  const value = useMemo(() => ({
    user, isAuthenticated: Boolean(user), loading, authError, serverUnreachable,
    retryConnection, login, register, logout, refreshUser, clearError,
  }), [user, loading, authError, serverUnreachable, retryConnection, login, register, logout, refreshUser, clearError]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuthContext must be used within AuthProvider");
  return context;
}
