import { useMemo } from "react";
import { workflows } from "../constants/mockData";

export function useWorkflows() {
  return useMemo(
    () => ({
      workflows,
      activeWorkflows: workflows.filter((workflow) => workflow.status !== "FAILED"),
    }),
    []
  );
}

export default useWorkflows;
