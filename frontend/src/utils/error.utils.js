export function formatApiError(error) {
  return error?.response?.data?.message ?? error?.message ?? "Unexpected error";
}
