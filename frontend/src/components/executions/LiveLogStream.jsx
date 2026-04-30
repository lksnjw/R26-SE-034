import Card from "../shared/ui/Card";
import { logs } from "../../constants/mockData";

function LiveLogStream() {
  return (
    <Card className="bg-gray-950 text-gray-100 dark:bg-black">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-bold text-white">Live Log Stream</h2>
        <span className="relative rounded-full bg-green-500/15 px-3 py-1 text-xs font-bold text-green-300">
          <span className="mr-2 inline-block h-2 w-2 rounded-full bg-green-400" />
          streaming
        </span>
      </div>
      <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap text-xs leading-7 text-gray-300">
        {logs.join("\n")}
      </pre>
    </Card>
  );
}

export default LiveLogStream;
