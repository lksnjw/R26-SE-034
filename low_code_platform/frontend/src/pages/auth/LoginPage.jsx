import { useRef, useState } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useAuthContext } from "../../context/AuthContext";
import LoginLayout from "../../layouts/LoginLayout";

export default function LoginPage({ onNavigate }) {
  const { login, loading, authError } = useAuthContext();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const submitting = useRef(false);
  const [submittingLocally, setSubmittingLocally] = useState(false);
  const busy = loading || submittingLocally;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting.current || loading) return;
    submitting.current = true;
    setSubmittingLocally(true);
    try {
      await login({ email, password });
      // AuthContext retains responsibility for session state and navigation.
    } catch {
      // The existing authentication context supplies the error message.
    } finally {
      submitting.current = false;
      setSubmittingLocally(false);
    }
  };

  return (
    <LoginLayout>
      <form className="login-form" onSubmit={handleSubmit} aria-busy={busy}>
        <div className="login-field">
          <label htmlFor="login-email">Email address</label>
          <input id="login-email" name="email" type="email" value={email}
            onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com"
            autoComplete="email" autoCapitalize="none" spellCheck={false} required disabled={busy}
            aria-describedby={authError ? "login-error" : undefined} aria-invalid={authError ? true : undefined} />
        </div>
        <div className="login-field">
          <label htmlFor="login-password">Password</label>
          <div className="login-input-wrap">
            <input id="login-password" name="password" className="login-password-input"
              type={showPassword ? "text" : "password"} value={password}
              onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password"
              autoComplete="current-password" required disabled={busy}
              aria-describedby={authError ? "login-error" : undefined} aria-invalid={authError ? true : undefined} />
            <button type="button" className="login-password-toggle" onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} disabled={busy}>
              {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
        </div>
        <div className="login-forgot-row">
          <button type="button" className="login-text-button" onClick={() => onNavigate?.("forgot-password")} disabled={busy}>Forgot password?</button>
        </div>
        {authError && <div id="login-error" className="login-error" role="alert">{authError}</div>}
        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? <><span className="login-spinner" aria-hidden="true" /> Signing in…</> : <>Sign in <ArrowRight aria-hidden="true" /></>}
        </button>
        <p className="login-signup">New to Agentic?
          <button type="button" className="login-text-button" onClick={() => onNavigate?.("register")} disabled={busy}>Create an account</button>
        </p>
      </form>
    </LoginLayout>
  );
}
