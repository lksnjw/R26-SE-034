import { useState } from "react";
import Button from "../shared/ui/Button";
import Input from "../shared/ui/Input";
import { authService } from "../../services/auth.service";

function LoginForm() {
  const [email, setEmail] = useState("admin@workflow.local");
  const [password, setPassword] = useState("password123");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await authService.login({ email, password });
      window.location.href = "/";
    } catch (err) {
      setError(err?.response?.data?.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <Input type="email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
      <Input type="password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
      {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
      <Button className="w-full" type="submit" disabled={loading}>
        {loading ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  );
}

export default LoginForm;
