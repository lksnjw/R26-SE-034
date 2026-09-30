import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { workspaceKey, writeWorkspaceValue } from "../utils/workspaceSession";
import { useAuthContext } from "../context/AuthContext";
import usePermissions from "../hooks/usePermissions";
import Sidebar from "../components/navigation/Sidebar";
import Topbar from "../components/navigation/Topbar";
import MobileNav from "../components/navigation/MobileNav";
import ServerUnreachableBanner from "../components/shared/ServerUnreachableBanner";

export function isWorkspacePath(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/" || path === "/chat" ||
    (/^\/chat\/[^/]+$/.test(path) && path !== "/chat/history");
}

export default function WorkspaceLayout({ children }) {
  const { hasAny } = usePermissions();
  const { user } = useAuthContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const location = useLocation();
  const returnKey = workspaceKey(user, "return");
  useEffect(() => {
    writeWorkspaceValue(returnKey, location.pathname + location.search);
  }, [returnKey, location.pathname, location.search]);
  return (
    <div className="fixed inset-0 flex bg-white text-gray-900 dark:bg-darkBackgroundVery dark:text-gray-100">
      <Sidebar isCollapsed={isSidebarCollapsed} onToggle={() => setIsSidebarCollapsed(current => !current)} />
      <div className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar />
        {hasAny(["workflow:read", "workflow:read_own", "execution:read_own"]) && <nav aria-label="Workspace shortcuts" className="flex justify-end border-b border-gray-200 px-4 py-2 text-xs font-medium text-primary dark:border-gray-800">
          <Link to="/dashboard">Dashboard</Link>
        </nav>}
        <ServerUnreachableBanner />
        <MobileNav />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
