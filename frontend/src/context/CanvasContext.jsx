import { createContext, useContext, useMemo, useState } from "react";
import { workflowNodes } from "../constants/mockData";

const CanvasContext = createContext(null);

export function CanvasProvider({ children }) {
  const [nodes, setNodes] = useState(workflowNodes);
  const [selectedNodeId, setSelectedNodeId] = useState(workflowNodes[0]?.id);

  const value = useMemo(
    () => ({
      nodes,
      selectedNodeId,
      selectedNode: nodes.find((node) => node.id === selectedNodeId),
      setNodes,
      setSelectedNodeId,
    }),
    [nodes, selectedNodeId]
  );

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas() {
  const context = useContext(CanvasContext);
  if (!context) {
    throw new Error("useCanvas must be used within CanvasProvider");
  }
  return context;
}
