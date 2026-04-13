import { create } from "zustand";
import { workflowNodes } from "../constants/mockData";

export const useCanvasStore = create((set) => ({
  nodes: workflowNodes,
  selectedNodeId: workflowNodes[0]?.id,
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
}));
