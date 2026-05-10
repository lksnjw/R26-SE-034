import AuthLayout from "../../layouts/AuthLayout";
import RegisterForm from "../../components/auth/RegisterForm";

function RegisterPage() {
  return (
    <AuthLayout title="Create your workflow account">
      <RegisterForm />
    </AuthLayout>
  );
}

export default RegisterPage;
