import { Icon } from "@iconify/react";

function ChatWelcome() {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-center dark:border-gray-800">
      <Icon icon="hugeicons:ai-magic" className="mx-auto h-10 w-10 text-primary" />
      <h3 className="mt-3 text-lg font-bold text-gray-950 dark:text-white">
        Turn operational intent into an executable flow.
      </h3>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-gray-500 dark:text-gray-400">
        Mention the event trigger, systems involved, decision rules, and fallback behavior.
      </p>
    </div>
  );
}

export default ChatWelcome;
