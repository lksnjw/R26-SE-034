import ChatSessionItem from "./ChatSessionItem";

const sessions = [
  "Invoice exception resolver",
  "Inventory reorder planner",
  "Refund triage workflow",
  "Vendor risk escalation",
];

function ChatHistory() {
  return (
    <aside className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
      <h2 className="text-base font-bold text-gray-950 dark:text-white">Sessions</h2>
      <div className="mt-4 space-y-2">
        {sessions.map((session, index) => (
          <ChatSessionItem key={session} title={session} active={index === 0} />
        ))}
      </div>
    </aside>
  );
}

export default ChatHistory;
