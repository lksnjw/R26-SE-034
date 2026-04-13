import { Icon } from "@iconify/react";
import Breadcrumb from "./Breadcrumb";
import CommandPalette from "./CommandPalette";
import { appConfig } from "../../config/app";
import { useTheme } from "../../context/ThemeContext";
import { useNotifications } from "../../context/NotificationContext";

function Topbar() {
  const { isDarkMode, toggleTheme } = useTheme();
  const { notify } = useNotifications();

  return (
    <header className="flex items-center justify-between gap-4 border-b border-gray-200 bg-white px-4 py-4 transition-colors duration-200 dark:border-darkBackgroundVery dark:bg-darkBackground sm:px-6">
      <div className="min-w-0 flex-1 sm:flex-none">
        <div className="flex items-center gap-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-white shadow-panel">
            <Icon icon="tabler:git-branch" className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold text-gray-950 dark:text-white">
                {appConfig.name}
              </span>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-darkBackgroundVery dark:bg-darkBackgroundVery dark:text-gray-300">
                v{appConfig.version}
              </span>
            </div>
            <Breadcrumb />
          </div>
        </div>
      </div>

      <CommandPalette />

      <div className="flex shrink-0 items-center gap-3">
        <button type="button" onClick={toggleTheme} className="icon-button" aria-label="Toggle theme">
          <Icon
            icon={isDarkMode ? "mdi:weather-sunny" : "mdi:weather-night"}
            className="h-5 w-5"
          />
        </button>
        <button
          type="button"
          className="icon-button relative hidden sm:flex"
          aria-label="Run history"
          onClick={() => notify("Run history panel is ready for API connection.")}
        >
          <Icon icon="mdi:history" className="h-5 w-5" />
          <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-green-500 text-[10px] font-bold text-white dark:border-gray-900">
            8
          </span>
        </button>
        <button
          type="button"
          className="icon-button relative hidden sm:flex"
          aria-label="Notifications"
          onClick={() => notify("No critical alerts. Live log stream is healthy.")}
        >
          <Icon icon="mdi:bell-outline" className="h-5 w-5" />
          <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-red-500 text-[10px] font-bold text-white dark:border-gray-900">
            3
          </span>
        </button>
      </div>
    </header>
  );
}

export default Topbar;
