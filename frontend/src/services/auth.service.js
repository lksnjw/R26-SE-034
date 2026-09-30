import { apiClient, clearStoredSession } from "../config/axios";
import { currentAuthorityEpoch, staleAuthorityError } from "../utils/authAuthority";

function authorityGuard(isCurrent) {
  const epoch = currentAuthorityEpoch();
  return () => epoch === currentAuthorityEpoch() && (!isCurrent || isCurrent());
}

/*******************************************************************************
 * Function: persistSession
 *
 * Performs the persist Session operation on session for the auth service module.
 ******************************************************************************/
function persistSession(session, isCurrent = () => true) {
  if (!isCurrent()) throw staleAuthorityError();
  if (session?.accessToken) {
    localStorage.setItem("workflow.authToken", session.accessToken);
  }
  if (session?.refreshToken) {
    localStorage.setItem("workflow.refreshToken", session.refreshToken);
  }
  if (session?.user) {
    localStorage.setItem("workflow.user", JSON.stringify(session.user));
  }
  return session;
}

export const authService = {
/*******************************************************************************
 * Function: login
 *
 * Performs the login operation on the application for the auth service module.
 ******************************************************************************/
  async login(credentials, { isCurrent } = {}) {
    const current = authorityGuard(isCurrent);
    const response = await apiClient.post("/auth/login", credentials);
    return persistSession(response.data.data, current);
  },

/*******************************************************************************
 * Function: register
 *
 * Performs the register operation on the application for the auth service module.
 ******************************************************************************/
  async register(payload, { isCurrent } = {}) {
    const current = authorityGuard(isCurrent);
    const response = await apiClient.post("/auth/register", payload);
    return persistSession(response.data.data, current);
  },

/*******************************************************************************
 * Function: me
 *
 * Performs the me operation on the application for the auth service module.
 ******************************************************************************/
  async me({ isCurrent } = {}) {
    const current = authorityGuard(isCurrent);
    if (!current()) throw staleAuthorityError();
    const response = await apiClient.get("/auth/me");
    if (!current()) throw staleAuthorityError();
    return response.data.data;
  },

/*******************************************************************************
 * Function: refresh
 *
 * Refreshes the application for the auth service module.
 ******************************************************************************/
  async refresh({ isCurrent } = {}) {
    const current = authorityGuard(isCurrent);
    const refreshToken = localStorage.getItem("workflow.refreshToken");
    const response = await apiClient.post("/auth/refresh", { refreshToken });
    return persistSession(response.data.data, current);
  },

/*******************************************************************************
 * Function: forgotPassword
 *
 * Performs the forgot Password operation on password for the auth service module.
 ******************************************************************************/
  async forgotPassword(email) {
    const response = await apiClient.post("/auth/forgot-password", { email });
    return response.data.data;
  },

/*******************************************************************************
 * Function: resetPassword
 *
 * Performs the reset Password operation on password for the auth service module.
 ******************************************************************************/
  async resetPassword(token, password) {
    const response = await apiClient.post("/auth/reset-password", { token, password });
    return response.data.data;
  },

/*******************************************************************************
 * Function: verifyEmail
 *
 * Performs the verify Email operation on email for the auth service module.
 ******************************************************************************/
  async verifyEmail(token) {
    const response = await apiClient.post("/auth/verify-email", { token });
    return response.data.data;
  },

/*******************************************************************************
 * Function: logout
 *
 * Performs the logout operation on the application for the auth service module.
 ******************************************************************************/
  async logout({ isCurrent = () => true, accessToken, refreshToken } = {}) {
    const current = authorityGuard(isCurrent);
    const capturedRefresh = refreshToken ?? localStorage.getItem("workflow.refreshToken");
    await apiClient.post("/auth/logout", { refreshToken: capturedRefresh }, accessToken ? {
      headers: { Authorization: `Bearer ${accessToken}` }, _authTokenOverride: true,
    } : {}).catch(() => null);
    if (current()) clearStoredSession();
  },

/*******************************************************************************
 * Function: oauthAuthorize
 *
 * Performs the oauth Authorize operation on authorize for the auth service module.
 ******************************************************************************/
  async oauthAuthorize(provider) {
    const response = await apiClient.get(`/auth/oauth/${provider}/authorize`);
    return response.data.data;
  },

/*******************************************************************************
 * Function: twoFactorVerify
 *
 * Performs the two Factor Verify operation on factor verify for the auth service module.
 ******************************************************************************/
  async twoFactorVerify(code) {
    const response = await apiClient.post("/auth/2fa/verify", { code });
    return response.data.data;
  },
};
