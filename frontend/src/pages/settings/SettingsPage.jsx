import Button from "../../components/shared/ui/Button";
import Card from "../../components/shared/ui/Card";
import ApiKeyCard from "../../components/settings/ApiKeyCard";
import IntegrationCard from "../../components/settings/IntegrationCard";
import LlmModelSelector from "../../components/settings/LlmModelSelector";
import PromptEditor from "../../components/settings/PromptEditor";
import RbacPolicyEditor from "../../components/settings/RbacPolicyEditor";
import SettingsNav from "../../components/settings/SettingsNav";
import WebhookForm from "../../components/settings/WebhookForm";
import { integrations } from "../../constants/mockData";

function SettingsPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="page-heading text-gray-950 dark:text-white">Platform Settings</h1>
          <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
            Configure runtime policy, integrations, model behavior, webhooks, and access rules.
          </p>
        </div>
        <Button>Save Changes</Button>
      </div>

      <SettingsNav />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Card>
            <h2 className="section-title">LLM Runtime</h2>
            <div className="mt-5 grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
              <LlmModelSelector />
              <PromptEditor />
            </div>
          </Card>
          <Card>
            <h2 className="section-title">RBAC Policy</h2>
            <div className="mt-5">
              <RbacPolicyEditor />
            </div>
          </Card>
          <Card>
            <h2 className="section-title mb-5">Webhook Endpoint</h2>
            <WebhookForm />
          </Card>
        </div>
        <div className="space-y-4">
          <ApiKeyCard />
          <div className="grid gap-4">
            {integrations.map((integration) => (
              <IntegrationCard key={integration.name} integration={integration} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default SettingsPage;
