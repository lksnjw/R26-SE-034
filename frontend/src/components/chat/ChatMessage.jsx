import MessageMarkdown from "./MessageMarkdown";

function ChatMessage({ message }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-6 ${
          isUser
            ? "bg-primary text-white"
            : "bg-backgroundLight text-gray-800 dark:bg-darkBackgroundVery dark:text-gray-100"
        }`}
      >
        <MessageMarkdown text={message.text} />
      </div>
    </div>
  );
}

export default ChatMessage;
