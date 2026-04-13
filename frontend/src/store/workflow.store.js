import { create } from "zustand";
import { workflows } from "../constants/mockData";

export const useWorkflowStore = create((set) => ({
  workflows,
  setWorkflows: (nextWorkflows) => set({ workflows: nextWorkflows }),
}));
