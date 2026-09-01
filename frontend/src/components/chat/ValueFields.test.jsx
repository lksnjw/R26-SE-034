/** @jest-environment jsdom */
import React, { useState } from "react";
import { test, expect, afterEach } from "@jest/globals";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import ValueFields from "./ValueFields";
afterEach(cleanup);
function Harness({ initial, onValue }) {
  const [value, setValue] = useState(initial);
  return <ValueFields value={value} onChange={(next) => { setValue(next); onValue(next); }} />;
}
test("typed nested fields edit without raw JSON or coercing unrelated values", () => {
  let result;
  const { container } = render(<Harness initial={{ count: 0, enabled: false, nested: { recipient: "old" }, ids: ["a"], missing: null }} onValue={(next) => { result = next; }} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Parameters · nested · recipient" }), { target: { value: "manager" } });
  expect(result).toEqual({ count: 0, enabled: false, nested: { recipient: "manager" }, ids: ["a"], missing: null });
  fireEvent.change(screen.getByRole("combobox", { name: "Parameters · enabled" }), { target: { value: "true" } });
  expect(result.enabled).toBe(true);
  expect(container.querySelector("textarea")).toBeNull();
});
test("new run input fields have explicit types, duplicates are rejected and removal is local", () => {
  let result;
  render(<Harness initial={{}} onValue={(next) => { result = next; }} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Parameters new field name" }), { target: { value: "limit" } });
  fireEvent.click(screen.getByRole("button", { name: "Add field" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Parameters · limit value type" }), { target: { value: "number" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Parameters · limit" }), { target: { value: "10" } });
  expect(result).toEqual({ limit: 10 });
  fireEvent.change(screen.getByRole("textbox", { name: "Parameters new field name" }), { target: { value: "limit" } });
  fireEvent.click(screen.getByRole("button", { name: "Add field" }));
  expect(screen.getByRole("alert").textContent).toBe("Enter a unique field name.");
  expect(result).toEqual({ limit: 10 });
  fireEvent.click(screen.getByRole("button", { name: "Remove limit" }));
  expect(result).toEqual({});
});
