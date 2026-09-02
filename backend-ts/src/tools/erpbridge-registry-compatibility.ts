import { exactBridgeName, matchesBridgeContract } from "./erpbridge-contract.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { ErpbridgeMcpSdkTool } from "./erpbridge-mcp-client.js";

export type RegistryCompatibilityReport = Readonly<{
  compatible: boolean;
  missing: string[];
  incompatible: { name: string; reason: string }[];
  unreviewed: string[];
  duplicateRemoteNames: string[];
}>;

/*******************************************************************************
 * Function: compareErpbridgeRegistry
 *
 * Compares local and remote tool definitions for registry drift.
 ******************************************************************************/
export function compareErpbridgeRegistry(
  localTools: readonly ToolDefinition[],
  remoteTools: readonly ErpbridgeMcpSdkTool[],
): RegistryCompatibilityReport {
  const expected = new Map<string, ToolDefinition>();
  for (const tool of localTools) {
    const name = exactBridgeName(tool) || tool.name.trim();
    if (name !== "") expected.set(name, tool);
  }
  const remote = new Map<string, ErpbridgeMcpSdkTool>();
  const duplicateRemoteNames: string[] = [];
  for (const tool of remoteTools) {
    const name = tool.name.trim();
    if (name === "") continue;
    if (remote.has(name)) duplicateRemoteNames.push(name);
    remote.set(name, tool);
  }
  const missing: string[] = [];
  const incompatible: { name: string; reason: string }[] = [];
  for (const [name, local] of expected) {
    const actual = remote.get(name);
    if (actual === undefined) {
      missing.push(name);
      continue;
    }
    if (!matchesBridgeContract(local, actual))
      incompatible.push({ name, reason: local.bridge_contract ? "reviewed revision, digest, role or input/output schema differs" : "input schema differs" });
  }
  const unreviewed = [...remote.keys()]
    .filter((name) => !expected.has(name))
    .sort();
  return {
    compatible:
      missing.length === 0 &&
      incompatible.length === 0 &&
      unreviewed.length === 0 &&
      duplicateRemoteNames.length === 0,
    missing: missing.sort(),
    incompatible: incompatible.sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    unreviewed,
    duplicateRemoteNames: [...new Set(duplicateRemoteNames)].sort(),
  };
}

/*******************************************************************************
 * Function: assertErpbridgeRegistryCompatible
 *
 * Rejects a registry compatibility report containing drift.
 ******************************************************************************/
export function assertErpbridgeRegistryCompatible(
  report: RegistryCompatibilityReport,
): void {
  if (report.compatible) return;
  throw new Error(
    `ERPBridge registry drift: ${JSON.stringify({ missing: report.missing, incompatible: report.incompatible, unreviewed: report.unreviewed, duplicateRemoteNames: report.duplicateRemoteNames })}`,
  );
}
