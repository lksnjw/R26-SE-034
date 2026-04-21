import { analyticsSeries, dashboardMetrics } from "../constants/mockData";

export const analyticsService = {
  async summary() {
    return dashboardMetrics;
  },
  async series() {
    return analyticsSeries;
  },
};
