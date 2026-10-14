import { loadConfig } from "../config/config.js";
import { buildApp } from "../http/app.js";
import type { Repository } from "../repository/store.js";
import { hashPassword } from "../authn/password.js";
import { reconcileInterruptedExecutions } from "../runner/read-checkpoints.js";
import { APPLICATION_STORAGE_TIMEOUT_MS, openApplicationResources, constructApplicationRuntime } from "./application-runtime.js";

/** Process-only startup wait. The host closes acquired resources on failure. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}

async function hostProduction(): Promise<void> {
  const root = process.cwd();
  const config = loadConfig(process.env, root);
  const resources = await openApplicationResources({ config, root,
    onRegistriesLoaded: () => console.log(`[startup] Registries loaded — connecting to ${config.storageDriver} storage...`),
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let closeResult: Promise<void> | undefined;
  /** HTTP workers finish before MCP/storage ownership is released. Each cleanup
   * runs even if the preceding owner fails; callers share one awaited close. */
  function closeHost(): Promise<void> {
    if (closeResult) return closeResult;
    closeResult = (async () => {
      const failures: unknown[] = [];
      try { await app?.close(); } catch (error) { failures.push(error); }
      try { await resources.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Application host cleanup could not be fully confirmed");
    })();
    return closeResult;
  }

  const interrupt = () => { void shutdown(); };
  const terminate = () => { void shutdown(); };
  function removeSignals() {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
  async function shutdown() {
    let failed = false;
    try { await closeHost(); }
    catch { failed = true; console.warn("[shutdown] Application cleanup could not be fully confirmed; no execution replay"); }
    finally { removeSignals(); }
    // Retain explicit process exit for watch restarts after awaited cleanup.
    process.exit(failed ? 1 : 0);
  }

  try {
    console.log("[startup] Repository state loaded.");
    await withTimeout(bootstrapAdministrator(resources.repository, config.platformAdminEmail, config.platformAdminPassword),
      APPLICATION_STORAGE_TIMEOUT_MS, "Administrator bootstrap");
    console.log("[startup] Administrator bootstrapped.");
    await withTimeout(reconcileInterruptedExecutions(resources.repository), APPLICATION_STORAGE_TIMEOUT_MS, "Execution reconciliation");
    console.log("[startup] Executions reconciled.");
    const runtime = await constructApplicationRuntime(resources);
    app = await buildApp(runtime.services);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    await app.listen({ host: "0.0.0.0", port: config.port });
    // Do not dispatch the legacy scheduler with its fabricated administrator.
    console.log("[scheduler] Legacy cron dispatch disabled; safe service-principal scheduler is required");
  } catch (error) {
    removeSignals();
    try { await closeHost(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Application startup failed and cleanup could not be fully confirmed"); }
    throw error;
  }
}

// Raw adapter/storage errors and AggregateError members may contain sensitive
// upstream data. Preserve them inside the construction/host cleanup scope;
// never hand that object to Node's uncaught-error renderer.
try { await hostProduction(); }
catch { throw new Error("Application startup failed; initialization or cleanup was not confirmed (upstream details suppressed)"); }

/*******************************************************************************
 * Function: bootstrapAdministrator
 *
 * Creates or updates the bootstrap administrator from startup configuration.
 ******************************************************************************/
async function bootstrapAdministrator(
  repository: Repository,
  email: string,
  password: string,
): Promise<void> {
  const existing = await repository.read((state) =>
    Object.values(state.users).find(
      (user) => user.email.toLowerCase() === email.toLowerCase(),
    ),
  );
  const passwordHash = await hashPassword(password);
  if (existing !== undefined) {
    // Always sync the password from .env so a restart picks up credential changes.
    await repository.mutate((state) => { state.passwordHashes[String(existing.id)] = passwordHash; });
    return;
  }
  await repository.mutate((state) => {
    state.counter += 1;
    const id = `usr_${state.counter}_admin`;
    state.users[id] = {
      id,
      name: "Platform Admin",
      email: email.toLowerCase(),
      roleId: "role_admin",
      permissionOverrides: [],
      status: "Active",
      initials: "PA",
      departmentId: null,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
    };
    state.passwordHashes[id] = passwordHash;
  });
}
