import { NAVIGATION_GROUPS } from "../../constants/navigation";
import { useRoute } from "../../context/RouteContext";

function MobileNav() {
  const { activeMain, navigateTo } = useRoute();

  return (
    <div className="border-b border-gray-200 bg-backgroundLight px-4 py-3 dark:border-darkBackgroundVery dark:bg-darkBackground md:hidden">
      <div className="flex gap-2 overflow-x-auto scrollbar-hide">
        {NAVIGATION_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            onClick={() => navigateTo(group.id, group.subMenu[0]?.id)}
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-semibold ${
              activeMain === group.id
                ? "bg-primary text-white"
                : "bg-white text-gray-600 dark:bg-darkBackgroundVery dark:text-gray-300"
            }`}
          >
            {group.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default MobileNav;
