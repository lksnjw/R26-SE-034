import { getNavigationGroup } from "../../constants/navigation";
import { useRoute } from "../../context/RouteContext";

function Breadcrumb() {
  const { activeMain, activeSub } = useRoute();
  const group = getNavigationGroup(activeMain);
  const sub = group.subMenu.find((item) => item.id === activeSub);

  return (
    <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
      {group.label} / {sub?.label ?? "Overview"}
    </p>
  );
}

export default Breadcrumb;
