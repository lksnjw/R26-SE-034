import { executions, logs } from "../constants/mockData";

export const executionService = {
  async list() {
    return executions;
  },
  async getLogs() {
    return logs;
  },
  async run(workflowId) {
    return { id: `run-${Date.now()}`, workflowId, status: "PENDING" };
  },
};
