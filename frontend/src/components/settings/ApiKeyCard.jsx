import Card from "../shared/ui/Card";
import CopyButton from "../shared/ui/CopyButton";

function ApiKeyCard() {
  const key = "wf_live_••••••••••••••••2F91";

  return (
    <Card>
      <h2 className="section-title">API Key</h2>
      <div className="mt-4 flex items-center justify-between rounded-xl bg-backgroundLight p-3 dark:bg-darkBackgroundVery">
        <code className="text-sm font-semibold text-gray-700 dark:text-gray-200">{key}</code>
        <CopyButton value={key} />
      </div>
    </Card>
  );
}

export default ApiKeyCard;
