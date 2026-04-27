function ChatSessionItem({ title, active }) {
  return (
    <button
      type="button"
      className={`w-full rounded-xl px-3 py-2 text-left text-sm font-semibold transition ${
        active
          ? "bg-primary text-white"
          : "bg-backgroundLight text-gray-600 hover:text-primary dark:bg-darkBackgroundVery dark:text-gray-300"
      }`}
    >
      {title}
    </button>
  );
}

export default ChatSessionItem;
