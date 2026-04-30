import { logs } from "../constants/mockData";

export function useLiveLog() {
  return { logs, isConnected: true };
}

export default useLiveLog;
