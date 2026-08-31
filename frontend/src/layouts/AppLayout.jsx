import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuthContext } from "../context/AuthContext";
import usePermissions from "../hooks/usePermissions";
import { workspaceReturnPath } from "../utils/workspaceSession";
import Sidebar from "../components/navigation/Sidebar";
import Topbar from "../components/navigation/Topbar";
import MobileNav from "../components/navigation/MobileNav";
import ServerUnreachableBanner from "../components/shared/ServerUnreachableBanner";

/*******************************************************************************
 * Function: AppLayout
 *
 * Performs the App Layout operation on layout for the AppLayout module.
 ******************************************************************************/
function AppLayout({ children }) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const { user } = useAuthContext();
  const { hasAny } = usePermissions();

  return (
    <div className="fixed inset-0 flex bg-backgroundLight transition-colors duration-200 dark:bg-darkBackgroundVery">
      <Sidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((current) => !current)}
      />

      <div className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar />
        {hasAny(["chat:use", "workflow:write"]) && <Link to={workspaceReturnPath(user)} className="border-b border-gray-200 px-4 py-2 text-xs font-medium text-primary dark:border-gray-800">← Back to workspace</Link>}
        <ServerUnreachableBanner />
        <MobileNav />
        <main className="h-0 min-h-0 flex-1 overflow-hidden bg-white p-4 transition-colors duration-200 dark:bg-darkBackgroundVery sm:p-6">
          <div className="h-full overflow-y-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export default AppLayout;
