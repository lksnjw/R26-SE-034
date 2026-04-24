import { Icon } from "@iconify/react";

const tools = [
  "mdi:magnify-plus-outline",
  "mdi:magnify-minus-outline",
  "mdi:fit-to-page-outline",
  "mdi:grid",
  "mdi:undo",
  "mdi:redo",
];

function CanvasToolbar() {
  return (
    <div className="flex flex-wrap gap-2">
      {tools.map((icon) => (
        <button key={icon} type="button" className="icon-button" aria-label={icon}>
          <Icon icon={icon} className="h-5 w-5" />
        </button>
      ))}
    </div>
  );
}

export default CanvasToolbar;
