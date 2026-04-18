import AuthLayout from "../../layouts/AuthLayout";
import LoginForm from "../../components/auth/LoginForm";
import OAuthButtons from "../../components/auth/OAuthButtons";

function LoginPage() {
  return (
    <AuthLayout title="Sign in to Agentic Workflow Engine">
      <LoginForm />
      <div className="my-5 border-t border-gray-200 dark:border-gray-800" />
      <OAuthButtons />
    </AuthLayout>
  );
}

export default LoginPage;
