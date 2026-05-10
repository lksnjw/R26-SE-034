import ChatSessionItem from "./ChatSessionItem";
import Button from "../shared/ui/Button";

function ChatHistory({ sessions, activeSessionId, onSelect, onCreate, loading, error }) {
  return (
    <aside className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-darkBackground">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-gray-950 dark:text-white">Sessions</h2>
        <Button variant="secondary" className="px-3 py-1 text-xs" onClick={() => onCreate?.()}>
          New
        </Button>
      </div>
      {error ? <p className="mt-3 text-xs font-medium text-red-600">{error}</p> : null}
      <div className="mt-4 space-y-2">
        {loading ? <p className="text-sm text-gray-500">Loading sessions...</p> : null}
        {sessions.map((session) => (
          <ChatSessionItem
            key={session.id}
            title={session.title}
            active={session.id === activeSessionId}
            onClick={() => onSelect?.(session.id)}
          />
        ))}
      </div>
    </aside>
  );
}

export default ChatHistory;
