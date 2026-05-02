import Card from "../../components/shared/ui/Card";
import Toggle from "../../components/shared/ui/Toggle";

function SecurityPage() {
  return (
    <Card>
      <h1 className="page-heading text-gray-950 dark:text-white">Security</h1>
      <div className="mt-6 space-y-4">
        <Toggle checked label="Two-factor authentication" />
        <Toggle checked label="Require approval before production runs" />
      </div>
    </Card>
  );
}

export default SecurityPage;
