import { NAVIGATION_GROUPS } from "../constants/navigation";

export const appRoutes = NAVIGATION_GROUPS.flatMap((group) =>
  group.subMenu.map((item) => ({
    id: `${group.id}.${item.id}`,
    main: group.id,
    sub: item.id,
    label: item.label,
  }))
);
