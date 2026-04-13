import { create } from "zustand";

export const useAuthStore = create((set) => ({
  user: { name: "Lakshan Jay", role: "Platform Admin" },
  setUser: (user) => set({ user }),
}));
