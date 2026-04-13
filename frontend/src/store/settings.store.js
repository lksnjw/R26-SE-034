import { create } from "zustand";

export const useSettingsStore = create((set) => ({
  model: "gpt-5.4",
  setModel: (model) => set({ model }),
}));
