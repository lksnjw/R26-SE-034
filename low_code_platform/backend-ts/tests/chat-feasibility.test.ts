import { describe, expect, test } from "vitest";
import { checkFeasibility } from "../src/http/handlers/chat-feasibility.js";

describe("advisory chat feasibility catalog", () => {
  test("short keywords require token boundaries instead of matching unrelated words", () => {
    const result = checkFeasibility("Compose a daily management summary", "Client");
    expect(result).toEqual({ feasible: true });
  });

  test("explicit short and punctuated phrases still match catalog entries", () => {
    expect(checkFeasibility("Show PO status", "Client")).toMatchObject({ feasible: false, matchedWorkflow: { id: "wf_purchase_orders" } });
    expect(checkFeasibility("Create a purchase-order", "Platform Admin")).toMatchObject({ feasible: true, matchedWorkflow: { id: "wf_create_purchase_order" } });
  });

  test("global blocks and role restrictions remain advisory denials", () => {
    expect(checkFeasibility("Please delete all data", "Platform Admin")).toMatchObject({ feasible: false });
    expect(checkFeasibility("Show employees", "Workflow Builder")).toMatchObject({ feasible: false, matchedWorkflow: { id: "wf_employee_list" } });
    expect(checkFeasibility("Show invoices", "Workflow Builder")).toMatchObject({ feasible: true, matchedWorkflow: { id: "wf_invoice_list" } });
  });
});
