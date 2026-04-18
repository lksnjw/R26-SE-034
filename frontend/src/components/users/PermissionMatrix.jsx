import Card from "../shared/ui/Card";

const rows = [
  ["Platform Admin", "Read", "Write", "Run", "Manage"],
  ["Workflow Builder", "Read", "Write", "Run", "-"],
  ["Execution Reviewer", "Read", "-", "Run", "-"],
  ["Auditor", "Read", "-", "-", "Audit"],
];

function PermissionMatrix() {
  return (
    <Card>
      <h2 className="section-title">Permission Matrix</h2>
      <div className="mt-5 overflow-hidden rounded-2xl border border-gray-200 text-sm dark:border-gray-800">
        {rows.map((row) => (
          <div key={row[0]} className="grid grid-cols-5 border-b border-gray-100 p-3 last:border-0 dark:border-gray-800">
            {row.map((cell, index) => (
              <span
                key={`${row[0]}-${cell}-${index}`}
                className={index === 0 ? "font-bold text-gray-950 dark:text-white" : "text-gray-600 dark:text-gray-300"}
              >
                {cell}
              </span>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

export default PermissionMatrix;
