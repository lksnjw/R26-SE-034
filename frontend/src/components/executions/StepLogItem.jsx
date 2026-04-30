function StepLogItem({ log, index }) {
  return (
    <div className="flex gap-3">
      <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
        {index + 1}
      </span>
      <p className="rounded-xl bg-backgroundLight px-4 py-3 text-sm text-gray-700 dark:bg-darkBackgroundVery dark:text-gray-200">
        {log}
      </p>
    </div>
  );
}

export default StepLogItem;
