import { integrations } from "../constants/mockData";

export function useSettings() {
  return { integrations, model: "gpt-5.4" };
}

export default useSettings;
