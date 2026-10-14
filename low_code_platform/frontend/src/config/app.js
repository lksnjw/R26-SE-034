import { createAppConfig } from "./endpoints";

const env = import.meta.env ?? {};
const browserOrigin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
export const appConfig = createAppConfig(env, browserOrigin);
