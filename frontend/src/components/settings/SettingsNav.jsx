const items = ["General", "Integrations", "LLM Policy", "RBAC", "Webhooks", "Billing"];

function SettingsNav() {
  return (
    <div className="flex gap-2 overflow-x-auto scrollbar-hide">
      {items.map((item, index) => (
        <button
          key={item}
          type="button"
          className={`shrink-0 rounded-full px-3 py-2 text-sm font-semibold ${
            index === 0
              ? "bg-primary text-white"
              : "bg-white text-gray-600 dark:bg-darkBackground dark:text-gray-300"
          }`}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

export default SettingsNav;
