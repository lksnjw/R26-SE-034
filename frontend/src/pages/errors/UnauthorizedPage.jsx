import EmptyState from "../../components/shared/ui/EmptyState";

function UnauthorizedPage() {
  return <EmptyState icon="mdi:lock-alert-outline" title="Unauthorized" />;
}

export default UnauthorizedPage;
