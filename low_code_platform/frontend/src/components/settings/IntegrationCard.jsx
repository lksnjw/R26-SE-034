import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";
import Button from "../shared/ui/Button";

/*******************************************************************************
 * Function: IntegrationCard
 *
 * Performs the Integration Card operation on card for the IntegrationCard module.
 ******************************************************************************/
function IntegrationCard({ integration }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon icon={integration.icon} className="h-5 w-5" />
        </span>
        <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-bold text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          Metadata only
        </span>
      </div>
      <h3 className="mt-4 text-base font-bold text-gray-950 dark:text-white">
        {integration.name}
      </h3>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{integration.type}</p>
      <p className="mt-2 text-xs text-gray-500">Stored label: {integration.status || "Not recorded"}. This is not a live agent connection.</p>
      <Button variant="secondary" className="mt-5 w-full" disabled>Typed adapter required</Button>
    </Card>
  );
}

export default IntegrationCard;
