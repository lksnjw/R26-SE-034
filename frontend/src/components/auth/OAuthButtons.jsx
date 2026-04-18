import Button from "../shared/ui/Button";

function OAuthButtons() {
  return (
    <div className="grid gap-2">
      <Button variant="secondary">Continue with Google</Button>
      <Button variant="secondary">Continue with GitHub</Button>
    </div>
  );
}

export default OAuthButtons;
