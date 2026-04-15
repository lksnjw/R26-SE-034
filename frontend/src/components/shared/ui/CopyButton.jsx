import { Icon } from "@iconify/react";
import { useNotifications } from "../../../context/NotificationContext";

function CopyButton({ value }) {
  const { notify } = useNotifications();

  const handleCopy = async () => {
    await navigator.clipboard?.writeText(value);
    notify("Copied to clipboard.");
  };

  return (
    <button type="button" onClick={handleCopy} className="icon-button" aria-label="Copy">
      <Icon icon="mdi:content-copy" className="h-4 w-4" />
    </button>
  );
}

export default CopyButton;
