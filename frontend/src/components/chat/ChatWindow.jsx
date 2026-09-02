import { useEffect, useRef, useState, useCallback } from "react";
import { Icon } from "@iconify/react";
import ChatMessage from "./ChatMessage";
import ChatWelcome from "./ChatWelcome";
import ChatOperationProgress from "./ChatOperationProgress";
import { chatService } from "../../services/chat.service";
import { readWorkspaceValue, writeWorkspaceValue } from "../../utils/workspaceSession";
import { peekWorkflowForChatEdit, clearWorkflowForChatEdit } from "../../utils/workflowCanvas.utils";

/** Animated streaming-style thinking indicator */
/*******************************************************************************
 * Function: ThinkingIndicator
 *
 * Performs the Thinking Indicator operation on indicator for the ChatWindow module.
 ******************************************************************************/
function ThinkingIndicator() {
  return (
    <div className="flex flex-col items-start gap-1 pl-1">
      <div className="mb-0.5 flex items-center gap-1.5">
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-3 w-3 text-primary" />
        </div>
        <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">Workflow Assistant</span>
      </div>
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <span className="flex gap-0.5">
          {[0, 0.15, 0.3].map((delay, i) => (
            <span
              key={i}
              className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
              style={{ animation: `pulse 1s ${delay}s infinite` }}
            />
          ))}
        </span>
        <span className="text-xs">Waiting for acknowledgement…</span>
      </div>
    </div>
  );
}

/** Auto-resizing textarea */
/*******************************************************************************
 * Function: AutoResizeTextarea
 *
 * Performs the Auto Resize Textarea operation on resize textarea for the ChatWindow module.
 ******************************************************************************/
function AutoResizeTextarea({ value, onChange, onKeyDown, disabled, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 200)}px`;
    }
  }, [value]);
  return (
    <textarea
      ref={ref}
      aria-label="Message to workflow assistant"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      disabled={disabled}
      placeholder={placeholder}
      rows={1}
      className="w-full resize-none bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 disabled:opacity-50"
      style={{ minHeight: "1.5rem", maxHeight: "200px", overflow: "hidden" }}
    />
  );
}

const QUICK_PROMPTS = [
  { icon: "mdi:invoice-text-outline", label: "Daily invoice report", text: "Draft a daily invoice and order report for my manager. Identify the ERP tools, delivery channel, recipient and timezone needed, and ask me for any missing details before execution." },
  { icon: "mdi:database-search-outline", label: "Query open POs", text: "Show me all open purchase orders from the ERP that are pending approval" },
  { icon: "mdi:robot-outline", label: "Review failure handling", text: "Review this workflow's failure handling. Identify which operations are safe to retry and which require reconciliation or human approval. Do not execute it." },
  { icon: "mdi:account-check-outline", label: "Supplier onboarding draft", text: "Draft a supplier onboarding workflow using available ERP tools. Identify unsupported capabilities and required approvals; do not execute it." },
];

/*******************************************************************************
 * Function: ChatWindow
 *
 * Performs the Chat Window operation on window for the ChatWindow module.
 ******************************************************************************/
function ChatWindow({ messages, onSend, loading, error, hasMoreMessages, loadingMore, onLoadMore, draftStorageKey, savedModel, nodeContext, onClearNodeContext, onChatChanged, operation, operationEvents, operationError, reconnecting, onCancelOperation, cancelling, onRefreshOperation }) {
  const [draft, setDraft] = useState(() => readWorkspaceValue(draftStorageKey));
  const [sendError, setSendError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const busy = loading || submitting;
  useEffect(() => { writeWorkspaceValue(draftStorageKey, draft); }, [draftStorageKey, draft]);
  const modelStorageKey = draftStorageKey ? `${draftStorageKey}.model` : undefined;
  const [selectedModel, setSelectedModel] = useState(() => savedModel || readWorkspaceValue(modelStorageKey));
  const [availableModels, setAvailableModels] = useState([]);
  const [modelError, setModelError] = useState("");
  const [catalogRetry, setCatalogRetry] = useState(0);
  const modelChosenByUser = useRef(false);
  const [editContext, setEditContext] = useState(() => peekWorkflowForChatEdit());
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const lastMessageIdRef = useRef(null);

  useEffect(() => {
    let current = true;
    chatService.models().then((catalog) => {
      if (!current) return;
      const models = (Array.isArray(catalog.models) ? catalog.models : []).map((id) => ({ id, label: id }));
      setAvailableModels(models);
      setSelectedModel((currentModel) => modelChosenByUser.current ? currentModel : savedModel || readWorkspaceValue(modelStorageKey) || catalog.binding?.model || "");
      setModelError(catalog.configured ? "" : "No model provider is configured.");
    }).catch(() => { if (current) { setAvailableModels([]); setModelError("Could not load configured models. Your draft is kept."); } });
    return () => { current = false; };
  }, [savedModel, modelStorageKey, catalogRetry]);
  useEffect(() => { writeWorkspaceValue(modelStorageKey, selectedModel); }, [modelStorageKey, selectedModel]);

  // Only auto-scroll to bottom when a message is actually appended (a new
  // send, or the last message changing) — never when older messages get
  // prepended by "Load earlier messages", which would otherwise yank the
  // view away from the history the user just asked to see.
  useEffect(() => {
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (lastId !== lastMessageIdRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      lastMessageIdRef.current = lastId;
    }
  }, [messages, loading]);

/*******************************************************************************
 * Function: handleLoadMore
 *
 * Loads the next-older page of messages while preserving the reader's
 * current scroll position (prepending content would otherwise shove
 * everything they were looking at further down the page).
 ******************************************************************************/
  const handleLoadMore = useCallback(async () => {
    const el = scrollContainerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    await onLoadMore?.();
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - prevHeight;
    });
  }, [onLoadMore]);

/*******************************************************************************
 * Function: handleSend
 *
 * Handles send for the ChatWindow module.
 ******************************************************************************/
  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || loading || submitting) return;
    setSubmitting(true);
    setSendError("");
    try {
      const result = await onSend?.(text, { model: selectedModel || undefined });
      if (result) {
        setDraft("");
        writeWorkspaceValue(draftStorageKey, "");
      }
    } catch (cause) {
      setSendError(`${cause?.response?.data?.message || "Could not send the message."} Your draft has been kept. Reload the workflow if the selected revision changed.`);
    } finally {
      setSubmitting(false);
    }
    // refocus after send
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [draft, loading, submitting, onSend, selectedModel, draftStorageKey]);

/*******************************************************************************
 * Function: handleKeyDown
 *
 * Handles key down for the ChatWindow module.
 ******************************************************************************/
  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isEmpty = messages.length === 0 && !loading;

  return (
    <section aria-label="Workflow chat" className="flex h-full min-h-0 flex-col overflow-hidden bg-white dark:bg-darkBackground">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
          <Icon icon="hugeicons:ai-magic" className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-gray-950 dark:text-white">Workflow Assistant</h2>
          <p className="text-[10px] text-gray-400">Generate · Query · Validate · Execute</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 rounded-full border border-gray-200 px-2.5 py-1 dark:border-gray-700">
          <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400">{loading ? "Request in progress" : "Chat"}</span>
        </div>
      </div>

      {nodeContext && <div aria-label="Chat node editing context" className="flex shrink-0 items-center gap-3 border-b border-primary/20 bg-primary/5 px-4 py-3">
        <div className="min-w-0 flex-1"><p className="text-xs font-semibold">Editing node · {nodeContext.nodeId}</p><p className="mt-1 text-[10px] text-gray-500">{nodeContext.label} · draft v{nodeContext.version}. Messages propose changes only to this node.</p></div>
        <button type="button" aria-label="Exit node editing" onClick={onClearNodeContext} disabled={busy} className="rounded p-1 text-gray-500"><Icon icon="lucide:x" /></button>
      </div>}

      {/* ── Workflow edit context banner ── */}
      {editContext && !nodeContext && (
        <div className="flex shrink-0 items-center gap-3 border-b border-indigo-100 bg-indigo-50 px-4 py-2.5 dark:border-indigo-900/40 dark:bg-indigo-900/20">
          <Icon icon="mdi:pencil-box-outline" className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
              Editing: <span className="font-bold">{editContext.workflowName || "Workflow"}</span>
            </p>
            <p className="text-[10px] text-indigo-500">Describe your changes. Review the returned workflow source before running it.</p>
          </div>
          <button
            type="button"
            onClick={() => { clearWorkflowForChatEdit(); setEditContext(null); }}
            className="shrink-0 rounded p-1 text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-200"
            title="Dismiss"
          >
            <Icon icon="mdi:close" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* ── Messages ── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-5">
          {isEmpty && <ChatWelcome onPrompt={setDraft} prompts={QUICK_PROMPTS} />}

          {hasMoreMessages && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-500 transition hover:border-primary hover:text-primary disabled:opacity-50 dark:border-gray-700 dark:text-gray-400"
              >
                {loadingMore
                  ? <Icon icon="mdi:loading" className="h-3.5 w-3.5 animate-spin" />
                  : <Icon icon="mdi:chevron-up" className="h-3.5 w-3.5" />
                }
                {loadingMore ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
          )}

          {messages.map((msg, idx) => (
            <ChatMessage key={msg.id ?? `${msg.role}-${idx}`} message={msg} onChatChanged={onChatChanged} />
          ))}

          {(operation || operationError) && <ChatOperationProgress operation={operation} events={operationEvents} error={operationError} reconnecting={reconnecting} onCancel={onCancelOperation} cancelling={cancelling} onRefresh={onRefreshOperation} />}
          {loading && !operation && <ThinkingIndicator />}

          {(error || sendError) && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-400">
              <Icon icon="mdi:alert-circle" className="mt-0.5 h-4 w-4 shrink-0" />
              {error || sendError}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* ── Input area ── */}
      <div className="shrink-0 border-t border-gray-100 p-4 dark:border-gray-800">
        <div className="mx-auto max-w-3xl">
          <div className={`rounded-2xl border bg-white px-4 py-3 transition dark:bg-darkBackgroundVery ${
            loading
              ? "border-gray-200 dark:border-gray-700"
              : "border-gray-300 shadow-sm focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10 dark:border-gray-600"
          }`}>
            <div ref={inputRef} tabIndex={-1}>
              <AutoResizeTextarea
                value={draft}
                onChange={setDraft}
                onKeyDown={handleKeyDown}
                disabled={busy}
                placeholder={nodeContext ? `Describe the change to ${nodeContext.nodeId}…` : "Describe a workflow, query ERP data, or ask anything… (Enter to send, Shift+Enter for newline)"}
              />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {!nodeContext && QUICK_PROMPTS.slice(0, 2).map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setDraft(p.text)}
                    disabled={busy}
                    className="flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-[10px] font-semibold text-gray-500 transition hover:border-primary hover:text-primary disabled:opacity-40 dark:border-gray-700 dark:text-gray-400"
                  >
                    <Icon icon={p.icon} className="h-3 w-3" />
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                {(availableModels.length > 0 || selectedModel) && (
                  <div className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 dark:border-gray-700 dark:bg-gray-800/60">
                    <Icon icon="mdi:chip" className="h-3 w-3 shrink-0 text-gray-400" />
                    <select
                      aria-label="Requested model"
                      value={selectedModel}
                      onChange={(e) => { modelChosenByUser.current = true; setSelectedModel(e.target.value); }}
                      disabled={busy}
                      className="bg-transparent text-[10px] font-semibold text-gray-600 outline-none disabled:opacity-50 dark:text-gray-300"
                    >
                      {selectedModel && !availableModels.some((model) => model.id === selectedModel) && <option value={selectedModel}>{selectedModel} · unavailable</option>}
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                    <button type="button" aria-label="Refresh configured models" title="Refresh configured models" disabled={busy} onClick={() => setCatalogRetry((value) => value + 1)} className="rounded p-1 text-gray-500 disabled:opacity-50"><Icon icon="mdi:refresh" className="h-3 w-3" /></button>
                  </div>
                )}
                <button
                  type="button"
                  aria-label="Send message"
                  onClick={handleSend}
                  disabled={busy || !draft.trim()}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-white transition hover:bg-primary/90 disabled:opacity-40"
                >
                  {loading
                    ? <Icon icon="mdi:loading" className="h-4 w-4 animate-spin" />
                    : <Icon icon="mdi:send" className="h-4 w-4" />
                  }
                </button>
              </div>
            </div>
            {modelError && <p role="status" className="mt-2 text-xs text-gray-600 dark:text-gray-300">{modelError} <button type="button" disabled={busy} className="underline" onClick={() => setCatalogRetry((value) => value + 1)}>Reload models</button></p>}
          </div>
          <p className="mt-1.5 text-center text-[10px] text-gray-400">
            {nodeContext ? "Enter to propose · configured provider · review Apply/Discard in the canvas · nothing executes" : "Enter to send · Shift+Enter for newline · A draft is not proof of ERP readiness or safe execution"}
          </p>
        </div>
      </div>
    </section>
  );
}

export default ChatWindow;
