import { appConfig } from "./app";

export function trackEvent(eventName, payload = {}) {
  if (!appConfig.analyticsEnabled) {
    return;
  }

  console.info("[analytics]", eventName, payload);
}
