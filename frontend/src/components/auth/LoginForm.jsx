import Button from "../shared/ui/Button";
import Input from "../shared/ui/Input";

function LoginForm() {
  return (
    <form className="space-y-4">
      <Input type="email" placeholder="Email" />
      <Input type="password" placeholder="Password" />
      <Button className="w-full" type="submit">Sign in</Button>
    </form>
  );
}

export default LoginForm;
