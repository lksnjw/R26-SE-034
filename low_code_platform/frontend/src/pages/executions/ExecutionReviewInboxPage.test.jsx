/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
let user = { id: "operator", roleId: "review-role", permissions: ["execution:approve", "execution:reconcile"] };
const getReviewInbox = jest.fn();
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => ({ user }) }));
jest.unstable_mockModule("../../services/execution-review.service", () => ({ getReviewInbox }));
const { default: Page } = await import("./ExecutionReviewInboxPage");
const clients = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); getReviewInbox.mockReset(); user = { id: "operator", roleId: "review-role", permissions: ["execution:approve", "execution:reconcile"] }; });
const item = { executionId: "run/one", reviewId: "review-one", kind: "approval", reviewView: "approval", requestedAt: "2026-10-06T10:00:00.000Z", state: "open", workflowName: "Daily manager report",
  requesterName: "Requester", executionStatus: "AWAITING_APPROVAL", canResume: false, noReplay: true, nodeId: "send", toolName: "Send report",
  expiresAt: "2026-10-06T11:00:00.000Z", statusLabel: "Awaiting decision", reviewAvailable: true, actionable: true, detail: "Open the exact action and arguments before deciding." };
const data = (params, items = [item], extra = {}) => ({ profile: "execution-review-inbox/v1", kind: params.kind, state: params.state,
  scopes: { approval: true, reconciliation: true }, items, nextCursor: null, hasMore: false, asOf: "2026-10-06T10:01:00.000Z", canResume: false, noReplay: true, ...extra });
function Context() { const location = useLocation(), navigate = useNavigate(); return <><output>{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>Browser back</button></>; }
function show(path = "/executions/reviews", client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })) {
  clients.push(client);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Context /><Page /></MemoryRouter></QueryClientProvider>);
}
test("readable tasks link only to exact minimum review; the inbox has no decision, resume or resend controls", async () => {
  getReviewInbox.mockImplementation(async params => data(params, [item, { ...item, executionId: "uncertain", kind: "reconciliation", reviewView: "reconciliation", toolName: "Send invoice", expiresAt: null, statusLabel: "Outcome uncertain" },
    { ...item, executionId: "report-page", kind: "reconciliation", reviewView: "report-page", toolName: "Invoice report", expiresAt: null, statusLabel: "Report page outcome uncertain" }]));
  const view = show();
  await screen.findByRole("list", { name: "Review tasks" });
  expect(screen.getAllByRole("heading", { name: "Daily manager report" })).toHaveLength(3);
  const links = screen.getAllByRole("link"); expect(links.map(link => link.getAttribute("href"))).toEqual(["/executions/run%2Fone?view=approval&approvalId=review-one", "/executions/uncertain?view=reconciliation", "/executions/report-page?view=report-page"]);
  expect(screen.queryByRole("button", { name: /approve|reject|resume|resend/i })).toBeNull(); expect(view.container.querySelector("pre")).toBeNull();
  expect(screen.getByText("This list cannot approve, execute, resume or resend an action.")).toBeTruthy();
});
test("filters reset pages, preserve URL/deep link and distinguish decision history from successful execution", async () => {
  getReviewInbox.mockImplementation(async params => data(params, [{ ...item, state: params.state, actionable: params.state === "open", statusLabel: params.state === "open" ? "Awaiting decision" : "Approved — not delivery confirmation" }]));
  show(); await screen.findByText("Awaiting decision"); fireEvent.change(screen.getByLabelText("View"), { target: { value: "closed" } });
  await screen.findByText("Approved — not delivery confirmation"); expect(screen.getByText("This is decision history, not run success or delivery confirmation.")).toBeTruthy();
  expect(screen.getByText("/executions/reviews?kind=all&state=closed")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Browser back" })); await screen.findByText("Awaiting decision");
  expect(getReviewInbox.mock.calls.some(([params]) => params.state === "closed" && !params.cursor)).toBe(true);
});

test.each(["open", "closed"])("protected %s item review links to the exact approval case, not an unsupported view", async state => {
  getReviewInbox.mockImplementation(async params => data(params, [{ ...item, reviewView: "protected-approval", state,
    actionable: state === "open", statusLabel: state === "open" ? "Awaiting decision" : "Closed — not dispatched" }]));
  show(`/executions/reviews?kind=approval&state=${state}`); await screen.findByRole("list", { name: "Review tasks" });
  expect(screen.getByText("Action approval")).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toBe("/executions/run%2Fone?view=approval&approvalId=review-one");
  expect(screen.queryByRole("button", { name: /approve|reject|resume|resend/i })).toBeNull();
});
test("paged tasks can go forward/back and a rejected cursor hides old tasks until an explicit first-page refresh", async () => {
  getReviewInbox.mockImplementation(async params => params.cursor ? data(params, [{ ...item, workflowName: "Second report", executionId: "two" }]) : data(params, [item], { nextCursor: "signed-one", hasMore: true }));
  show(); await screen.findByText("Daily manager report"); fireEvent.click(screen.getByRole("button", { name: "Next page" })); await screen.findByText("Second report");
  fireEvent.click(screen.getByRole("button", { name: "Previous page" })); await screen.findByText("Daily manager report");
  await waitFor(() => expect(screen.getByRole("button", { name: "Next page" }).disabled).toBe(false));
  getReviewInbox.mockImplementation(async params => { if (params.cursor) throw new Error("Authority changed; reload the first page"); return data(params, [item], { nextCursor: "signed-one", hasMore: true }); });
  fireEvent.click(screen.getByRole("button", { name: "Next page" })); await screen.findByText("Authority changed; reload the first page");
  expect(screen.queryByRole("list", { name: "Review tasks" })).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Refresh inbox" })); await screen.findByText("Daily manager report");
  await waitFor(() => expect(getReviewInbox.mock.calls.at(-1)[0].cursor).toBeUndefined());
});
test("unassigned approval scope and unsupported recovery are explained without inventing a globally empty inbox", async () => {
  getReviewInbox.mockImplementation(async params => data(params, [], { scopes: { approval: false, reconciliation: true } }));
  show("/executions/reviews?kind=all&state=open"); await screen.findByText("No review tasks on this page");
  expect(screen.getByText(/assigned by the active approval policy/)).toBeTruthy(); expect(screen.getByText(/Legacy waits and unsupported recovery profiles/)).toBeTruthy();
});
test("a returning page does not present a cached already-decided task as current before its fresh read", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(["execution-review-inbox", "operator", "review-role:execution:approve,execution:reconcile", "all", "open", null], data({ kind: "all", state: "open" }));
  let finish;
  getReviewInbox.mockImplementation(params => new Promise(resolve => { finish = () => resolve(data(params, [])); }));
  show("/executions/reviews", client); await screen.findByText("Loading your review tasks…");
  expect(screen.queryByRole("list", { name: "Review tasks" })).toBeNull();
  await waitFor(() => expect(finish).toEqual(expect.any(Function))); finish(); await screen.findByText("No review tasks on this page");
});
