import { useState } from "react";
import Button from "../shared/ui/Button";
import Input from "../shared/ui/Input";
import { authService } from "../../services/auth.service";

function RegisterForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await authService.register({ name, email, password, organizationName });
      window.location.href = "/";
    } catch (err) {
      setError(err?.response?.data?.message ?? "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <Input placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
      <Input type="email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
      <Input placeholder="Organization" value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} />
      <Input type="password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
      {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
      <Button className="w-full" type="submit" disabled={loading}>
        {loading ? "Creating account..." : "Create account"}
      </Button>
    </form>
  );
}

export default RegisterForm;
