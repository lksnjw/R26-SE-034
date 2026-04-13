import { create } from "zustand";

export const useUiStore = create((set) => ({
  isSidebarCollapsed: false,
  setSidebarCollapsed: (isSidebarCollapsed) => set({ isSidebarCollapsed }),
}));
