export function usePermissions() {
  return {
    can: () => true,
    role: "Platform Admin",
  };
}

export default usePermissions;
