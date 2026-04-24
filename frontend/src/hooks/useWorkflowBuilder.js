import { useState } from "react";
import { workflowNodes } from "../constants/mockData";

export function useWorkflowBuilder() {
  const [nodes, setNodes] = useState(workflowNodes);

  return {
    nodes,
    setNodes,
    addNode: (node) => setNodes((items) => [...items, node]),
  };
}

export default useWorkflowBuilder;
