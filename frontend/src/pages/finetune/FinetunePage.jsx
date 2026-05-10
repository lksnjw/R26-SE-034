import { useState, useRef, useEffect } from "react";
import { Icon } from "@iconify/react";

const modelStages = [
  {
    title: "Database Sync",
    detail: "Real-time CDC syncing active with main PostgreSQL database.",
    icon: "mdi:database-sync",
  },
  {
    title: "Model Status",
    detail: "Primary ERP extraction model is ONLINE and ready for queries.",
    icon: "mdi:server-network",
  },
  {
    title: "Indexed Records",
    detail: "142,850 total ERP records ingested and indexed.",
    icon: "mdi:file-table-box-multiple-outline",
  },
];

const mockChatHistory = [
  { role: "system", content: "You are connected to the ERP Assistant Model. Query enterprise data securely." },
  { role: "user", content: "What is the status of Purchase Order PO-9001?" },
  { role: "assistant", content: 'Purchase Order PO-9001 is currently marked as "Pending Approval". It was created on May 1st and is awaiting review by the Finance Department.' }
];

function FinetunePage() {
  const [messages, setMessages] = useState(mockChatHistory);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsTyping(true);

    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "This is a simulated ERP data response. The requested ERP records would normally be extracted from the database and summarized here." }
      ]);
      setIsTyping(false);
    }, 1500);
  };

  return (
    <div className="space-y-6 pb-10">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Enterprise Search
          </p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">ERP Model Integration</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Monitor your dedicated ERP model status and database synchronization health. Use the query playground to test how the model extracts and responds to internal business data.
          </p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-bold text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300">
          <Icon icon="mdi:check-circle" className="h-5 w-5" />
          System Synced
        </span>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {modelStages.map((stage) => (
          <div key={stage.title} className="surface-panel rounded-2xl p-5">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary dark:bg-primary/20">
              <Icon icon={stage.icon} className="h-6 w-6" />
            </span>
            <h2 className="mt-5 text-lg font-bold text-gray-950 dark:text-white">{stage.title}</h2>
            <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">{stage.detail}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        {/* Sync Settings */}
        <section className="surface-panel space-y-6 rounded-2xl p-6">
          <h2 className="section-title flex items-center gap-2 border-b border-gray-100 pb-4 dark:border-gray-800">
            <Icon icon="mdi:database-cog" className="h-5 w-5 text-primary" />
            Sync & Model Settings
          </h2>
          
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                  Target Database
                </label>
                <select className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none dark:border-gray-700 dark:bg-darkBackground dark:text-white">
                  <option>Primary ERP (PostgreSQL)</option>
                  <option>Legacy SAP (Oracle)</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                  Sync Interval
                </label>
                <select className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none dark:border-gray-700 dark:bg-darkBackground dark:text-white">
                  <option>Continuous (Real-time)</option>
                  <option>Hourly</option>
                  <option>Daily</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                  Active Model
                </label>
                <select className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none dark:border-gray-700 dark:bg-darkBackground dark:text-white">
                  <option>ERP Assistant v2.1</option>
                  <option>ERP Assistant v1.0 (Legacy)</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                  Max Results
                </label>
                <input type="number" defaultValue={5} className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none dark:border-gray-700 dark:bg-darkBackground dark:text-white" />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                Confidence Threshold
              </label>
              <input type="range" min="0" max="100" defaultValue="85" className="w-full accent-primary" />
              <div className="mt-1 flex justify-between text-xs text-gray-500">
                <span>0%</span>
                <span>85%</span>
                <span>100%</span>
              </div>
            </div>

            <button className="mt-2 w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-primary/90">
              Force Manual Sync
            </button>
          </div>
        </section>

        {/* Model Chat Playground */}
        <section className="surface-panel flex flex-col rounded-2xl p-0 overflow-hidden border border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 p-4 dark:border-gray-800 dark:bg-[#1a1d24]">
            <Icon icon="mdi:message-processing-outline" className="h-5 w-5 text-primary" />
            <h2 className="text-sm font-bold text-gray-900 dark:text-white">ERP Query Tester</h2>
          </div>

          <div className="flex flex-1 flex-col overflow-y-auto bg-white p-4 dark:bg-[#15181e] min-h-[300px] max-h-[400px]">
            {messages.map((msg, index) => (
              <div key={index} className={`mb-4 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                  msg.role === "user" 
                    ? "bg-primary text-white" 
                    : msg.role === "system"
                    ? "bg-gray-100 text-xs italic text-gray-500 dark:bg-gray-800 dark:text-gray-400 w-full text-center rounded-lg"
                    : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200"
                }`}>
                  <p>{msg.content}</p>
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex justify-start mb-4">
                <div className="rounded-2xl bg-gray-100 px-4 py-2.5 dark:bg-gray-800">
                  <div className="flex gap-1.5">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400"></span>
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: "0.2s" }}></span>
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" style={{ animationDelay: "0.4s" }}></span>
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="border-t border-gray-100 bg-white p-3 dark:border-gray-800 dark:bg-[#1a1d24]">
            <form onSubmit={handleSendMessage} className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask a question about ERP data..."
                className="w-full rounded-full border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none dark:border-gray-700 dark:bg-[#0d1117] dark:text-white"
              />
              <button
                type="submit"
                disabled={!input.trim() || isTyping}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                <Icon icon="mdi:send" className="h-4 w-4" />
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}

export default FinetunePage;
