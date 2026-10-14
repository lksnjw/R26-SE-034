import { expect, test } from "vitest";
import { nativeEchoTool, nativeEchoDefinition } from "../scripts/native-functions-operation-qa.mjs";
const resource = () => { const tool = nativeEchoTool(); tool.metadata.resourceDigest = "a".repeat(64);
  tool.spec.execution.approvedOrigins = ["http://mock-erp:8081"]; return tool; };
test("QA echo new revision explicitly unwraps deployed MockERP data without weakening acknowledgement", () => {
  const tool = nativeEchoDefinition(resource());
  expect(tool.bridge_contract.resource_version).toBe("1.0.1");
  expect(nativeEchoTool().spec.execution.responsePath).toBe("data");
  expect(tool.operation_contract).toMatchObject({ effect_class: "write", retry_policy: "never",
    confirmation: { path: ["value"], expected: "native-operation-qa-ack", meaning: "operation-accepted" } });
});
test("changed existing QA echo mapping and the old revision are refused, never overwritten", () => {
  const changed = resource(); delete changed.spec.execution.responsePath;
  expect(() => nativeEchoDefinition(changed)).toThrow("changed");
  const old = resource(); old.metadata.version = "1.0.0"; expect(() => nativeEchoDefinition(old)).toThrow();
});
