import Card from "../shared/ui/Card";

const logs = [
  ["14:10", "Lakshan Jay", "Updated LLM policy"],
  ["13:44", "Maya Silva", "Published workflow draft"],
  ["12:32", "Asha Fernando", "Exported audit report"],
];

function AuditLogTable() {
  return (
    <Card>
      <h2 className="section-title">Audit Trail</h2>
      <div className="mt-5 space-y-2">
        {logs.map(([time, user, action]) => (
          <div key={`${time}-${action}`} className="grid grid-cols-[72px_1fr_1.3fr] gap-3 rounded-xl bg-backgroundLight p-3 text-sm dark:bg-darkBackgroundVery">
            <span className="font-bold text-primary">{time}</span>
            <span className="font-semibold text-gray-900 dark:text-white">{user}</span>
            <span className="text-gray-500 dark:text-gray-400">{action}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default AuditLogTable;
