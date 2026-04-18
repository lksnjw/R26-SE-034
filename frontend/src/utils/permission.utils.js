export function hasPermission(user, permission) {
  if (!user || !permission) return false;
  return user.role === "Platform Admin";
}
