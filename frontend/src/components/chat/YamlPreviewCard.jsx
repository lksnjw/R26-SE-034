import Card from "../shared/ui/Card";
import CodeBlock from "../shared/ui/CodeBlock";

const yaml = `workflow:
  name: invoice_exception_resolver
  trigger: erp.invoice.created
  guardrails:
    - rbac.finance_approval
    - pii.redaction
  self_healing:
    retry_connector: true`;

function YamlPreviewCard() {
  return (
    <Card>
      <h3 className="text-base font-bold text-gray-950 dark:text-white">Generated YAML</h3>
      <div className="mt-4">
        <CodeBlock code={yaml} />
      </div>
    </Card>
  );
}

export default YamlPreviewCard;
