export function colorByStatus(status) {
  const colors = {
    DONE: "#16A34A",
    RUNNING: "#2563EB",
    FAILED: "#DC2626",
    HEALING: "#A855F7",
    PENDING: "#F5A700",
  };
  return colors[status] ?? colors.PENDING;
}
