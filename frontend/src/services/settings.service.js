import { integrations } from "../constants/mockData";

export const settingsService = {
  async get() {
    return {
      model: "gpt-5.4",
      integrations,
      policyMode: "guarded",
    };
  },
};
