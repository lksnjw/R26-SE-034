import Card from "../shared/ui/Card";
import FlowCanvas from "../canvas/FlowCanvas";

function FlowPreviewCard() {
  return (
    <Card>
      <h3 className="mb-4 text-base font-bold text-gray-950 dark:text-white">Flow Preview</h3>
      <div className="h-80 overflow-hidden rounded-2xl">
        <FlowCanvas />
      </div>
    </Card>
  );
}

export default FlowPreviewCard;
