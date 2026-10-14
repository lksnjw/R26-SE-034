import { expect, test, vi } from "vitest";
// @ts-expect-error Local JavaScript qualification entrypoint has no declarations
import { verifyFirestoreRecurringJoins } from "../scripts/firestore-recurring-joins.mjs";
// @ts-expect-error Local JavaScript qualification entrypoint has no declarations
import { reviewFixtureAnalysisEgress } from "../scripts/firestore-recurring-analysis.mjs";

vi.mock("../scripts/firestore-recurring-analysis.mjs", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), reviewFixtureAnalysisEgress: vi.fn(),
}));

// Harness diagnostics are not a substitute for the actual emulator campaign.
// A failed application restart must remain visible even when HTTP cleanup fails.
test.each([false, true])("recurring join qualification preserves its primary failure when cleanup fails=%s", async cleanupFails => {
  const primary = new Error("Synthetic repository restart failed"), cleanup = new Error("Synthetic provider restoration failed");
  const restore = vi.fn(async () => { if (cleanupFails) throw cleanup; });
  vi.mocked(reviewFixtureAnalysisEgress).mockResolvedValueOnce(restore);
  const tools = ["invoices", "orders"].map(resource => ({ name: resource, report_coverage_contract: { business_resource: resource } }));
  const setSynthesisFixture = vi.fn(), setAnalysisFixture = vi.fn(), request = vi.fn(), log = vi.fn();
  let caught: unknown;
  try {
    await verifyFirestoreRecurringJoins({ tools: [...tools, { name: "email", email_delivery_contract: {} }],
      getRepository: () => ({ snapshot: async () => { throw primary; } }), request, log,
      setSynthesisFixture, setAnalysisFixture, models: [], relatedInvoiceReports: [], relatedOrderReports: [], emails: [] });
  } catch (error) { caught = error; }
  if (cleanupFails) {
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).cause).toBe(primary);
    expect((caught as AggregateError).errors).toEqual([primary, cleanup]);
  } else expect(caught).toBe(primary);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(setAnalysisFixture).toHaveBeenCalledWith(undefined);
  expect(setSynthesisFixture).toHaveBeenCalledWith(undefined);
  expect(request).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
});
