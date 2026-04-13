import { useState } from "react";
import Sidebar from "../components/navigation/Sidebar";
import Topbar from "../components/navigation/Topbar";
import MobileNav from "../components/navigation/MobileNav";

function AppLayout({ children }) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  return (
    <div className="fixed inset-0 flex bg-backgroundLight transition-colors duration-200 dark:bg-darkBackgroundVery">
      <Sidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((current) => !current)}
      />

      <div className="flex h-screen min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar />
        <MobileNav />
        <main className="h-0 min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-white p-4 transition-colors duration-200 dark:bg-darkBackgroundVery sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export default AppLayout;
