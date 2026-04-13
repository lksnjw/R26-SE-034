import EmptyState from "../../components/shared/ui/EmptyState";

function NotFoundPage() {
  return (
    <EmptyState
      icon="mdi:map-marker-off-outline"
      title="Page not found"
      description="The selected workflow console route does not have an implementation yet."
    />
  );
}

export default NotFoundPage;
