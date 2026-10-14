export const chatQueryKeys = {
  sessions: scope => ["chat-sessions", scope || ""],
  session: (scope, id) => ["chat-session", scope || "", id || ""],
  operations: (scope, id) => ["chat-operations", scope || "", id || ""],
};
