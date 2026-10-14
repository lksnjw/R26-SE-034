import { recordedModelUsage, RECORDED_USAGE_EXPLANATION } from "../../utils/recordedModelUsage";

export default function RecordedModelUsage({ counts }) {
  const usage = recordedModelUsage(counts);
  return <section aria-label="Recorded model usage" className="mt-4 border-t border-gray-100 pt-4 dark:border-slate-700">
    <dl className="grid grid-cols-3 gap-4">
      {[["Input tokens", "input"], ["Output tokens", "output"], ["Recorded tokens", "total"]].map(([label, key]) => <div key={key}>
        <dt className="text-xs font-semibold text-gray-500">{label}</dt>
        <dd className="mt-1 text-sm font-semibold text-gray-950 dark:text-white">{usage ? usage[key].toLocaleString() : "Not reported"}</dd>
      </div>)}
    </dl>
    <p className="mt-2 text-xs text-gray-500">{RECORDED_USAGE_EXPLANATION}</p>
  </section>;
}
