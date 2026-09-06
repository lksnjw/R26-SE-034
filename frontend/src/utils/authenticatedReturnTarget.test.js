import { test, expect } from "@jest/globals";
import { authenticatedReturnTarget } from "./authenticatedReturnTarget";
test("sign-in preserves exact review, query and fragment within the same internal path", () => {
  expect(authenticatedReturnTarget({ pathname: "/executions/run", search: "?view=approval", hash: "#review" })).toEqual({ pathname: "/executions/run", search: "?view=approval", hash: "#review" });
});
test.each([null, {}, { pathname: "https://untrusted.test" }, { pathname: "//untrusted.test" }, { pathname: "/\\untrusted.test" }, { pathname: "/bad\npath" }])("untrusted return target %s cannot leave the app", from => expect(authenticatedReturnTarget(from)).toBe("/"));
