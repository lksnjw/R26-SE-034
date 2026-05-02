import { integrations } from "../constants/mockData";

export const integrationService = {
  async list() {
    return integrations;
  },
};
