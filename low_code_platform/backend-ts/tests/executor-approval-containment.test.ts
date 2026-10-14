import { resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Executor, partialResult } from "../src/runner/executor.js";
import type { Workflow } from "../src/models/schemas.js";

test("general executor cannot auto-approve a checkpoint or run following tools", async () => {
  const yaml = "name: Approval\ndescription: Explicit runtime checkpoint\ntrigger:\n  type: manual\nsteps:\n - id: approve\n   kind: approval\n   description: Manager approval\n - id: read\n   action: demo.echo\n";
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, new Repository(null));
  const gate = await validator.validateAndIssueToken("test", yaml, "Workflow Builder");
  expect(gate.token).not.toBeNull();
  const execute = vi.fn();
  const tools = new ToolRegistry();
  tools.register({ name: "demo.echo", description: "Echo", execute });
  const error = await new Executor(tools, validator).run("run1", { yaml } as Workflow, {}, gate.token!, { userId: "u", localRole: "Workflow Builder", erpbridgeRole: "workflow_builder" }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("cannot be auto-approved");
  expect(execute).not.toHaveBeenCalled();
  const partial = partialResult(error)!;
  expect(partial.timeline[0]?.status).toBe("FAILED");
  expect(partial.state).not.toHaveProperty("approve");
});
