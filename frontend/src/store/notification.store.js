import { create } from "zustand";

export const useNotificationStore = create((set) => ({
  notifications: [],
  push: (notification) =>
    set((state) => ({ notifications: [...state.notifications, notification] })),
}));
