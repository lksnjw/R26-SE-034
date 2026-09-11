import { expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/registry/schemas.js";
import { createExecutorToolBoundary } from "../src/tools/executor-tool-boundary.js";
import type { GovernedMCPClient } from "../src/tools/mcp-client.js";

const definition = Object.freeze({
  tool_id: "tool_fixture",
  name: "finance.read",
  description: "Fixture finance read",
} as ToolDefinition);

function source(initial: readonly ToolDefinition[]) {
  let listener: ((tool: ToolDefinition) => void) | null = null;
  const unsubscribe = vi.fn(() => { listener = null; });
  return {
    value: {
      snapshot: () => ({ tools: initial }),
      onToolUpsert: vi.fn((callback: (tool: ToolDefinition) => void) => { listener = callback; return unsubscribe; }),
    },
    emit(tool: ToolDefinition) { listener?.(tool); },
    unsubscribe,
  };
}

const legacyClient = Object.freeze({ execute: vi.fn() }) as unknown as GovernedMCPClient;

test("modern ERPBridge tools never enter the unscoped legacy executor", () => {
  const tools = source([definition]);
  const boundary = createExecutorToolBoundary({ transport: "erpbridge-mcp", tools: tools.value, legacyClient });

  expect(boundary.registry.names()).toEqual([]);
  expect(boundary.registry.get(definition.name)).toBeNull();
  expect(tools.value.onToolUpsert).not.toHaveBeenCalled();
  tools.emit(definition);
  expect(boundary.registry.names()).toEqual([]);
  boundary.close();
  expect(tools.unsubscribe).not.toHaveBeenCalled();
});

test("legacy local/mock bridge tools retain the governed compatibility boundary", () => {
  const tools = source([definition]);
  const boundary = createExecutorToolBoundary({ transport: "bridge-v1", tools: tools.value, legacyClient });
  const added = Object.freeze({ ...definition, tool_id: "tool_added", name: "finance.added" });

  expect(boundary.registry.names()).toEqual([definition.name]);
  tools.emit(added);
  expect(boundary.registry.names()).toEqual([added.name, definition.name]);
  boundary.close();
  expect(tools.unsubscribe).toHaveBeenCalledOnce();
});

test("legacy bridge startup fails closed without its governed client", () => {
  const tools = source([definition]);
  expect(() => createExecutorToolBoundary({ transport: "bridge-v1", tools: tools.value, legacyClient: null }))
    .toThrow(/requires a governed MCP client/);
});
