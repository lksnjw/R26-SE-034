import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { workspaceKey, writeWorkspaceValue } from "../utils/workspaceSession";
import { useAuthContext } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import usePermissions from "../hooks/usePermissions";
import ServerUnreachableBanner from "../components/shared/ServerUnreachableBanner";

export function isWorkspacePath(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/" || path === "/chat" ||
    (/^\/chat\/[^/]+$/.test(path) && path !== "/chat/history");
}

export default function WorkspaceLayout({ children }) {
  const { hasAny } = usePermissions();
  const { logout, user } = useAuthContext();
  const location = useLocation();
  const returnKey = workspaceKey(user, "return");
  useEffect(() => {
    writeWorkspaceValue(returnKey, location.pathname + location.search);
  }, [returnKey, location.pathname, location.search]);
  const { toggleTheme, isDarkMode } = useTheme();
  const links = [
    { to: "/dashboard", label: "Dashboard", permissions: ["workflow:read", "workflow:read_own", "execution:read_own"] },
    { to: "/workflows", label: "Workflows", permissions: ["workflow:read", "workflow:read_own"] },
    { to: "/executions", label: "Runs", permissions: ["workflow:read", "execution:read_own"] },
    { to: "/executions/reviews", label: "Reviews", permissions: ["execution:approve", "execution:reconcile"] },
    { to: "/settings", label: "Settings", permissions: ["settings:manage"] },
  ];
  return (
    <div className="fixed inset-0 flex flex-col bg-white text-gray-900 dark:bg-darkBackgroundVery dark:text-gray-100">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-2 dark:border-gray-800">
        <Link to="/" className="text-sm font-semibold">Agent Workspace</Link>
        <nav aria-label="Workspace navigation" className="flex flex-wrap items-center gap-4 text-xs">
          {links.filter((link) => hasAny(link.permissions)).map((link) => (
            <Link key={link.to} to={link.to} className="hover:text-primary">{link.label}</Link>
          ))}
          <Link to="/profile" className="hover:text-primary">Account</Link>
          <Link to="/chat/history" className="hover:text-primary">Chats</Link>
          <button type="button" onClick={toggleTheme} aria-label="Toggle color theme">{isDarkMode ? "Light" : "Dark"}</button>
          <button type="button" onClick={logout}>Sign out</button>
        </nav>
      </header>
      <ServerUnreachableBanner />
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
