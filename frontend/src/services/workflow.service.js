import { workflows } from "../constants/mockData";

export const workflowService = {
  async list() {
    return workflows;
  },
  async getById(id) {
    return workflows.find((workflow) => workflow.id === id) ?? workflows[0];
  },
  async create(payload) {
    return { id: `wf-${Date.now()}`, ...payload };
  },
};
