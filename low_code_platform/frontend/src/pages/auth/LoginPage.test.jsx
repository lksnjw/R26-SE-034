/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render as renderUI, screen } from "@testing-library/react";
import { ThemeProvider } from "../../context/ThemeContext";

const login = jest.fn();
let state = { login, loading: false, authError: "" };
jest.unstable_mockModule("../../context/AuthContext", () => ({ useAuthContext: () => state }));
const { default: LoginPage } = await import("./LoginPage");
const render = (ui) => renderUI(<ThemeProvider>{ui}</ThemeProvider>);
beforeEach(() => localStorage.setItem("theme", "light"));
afterEach(() => { cleanup(); login.mockReset(); state = { login, loading: false, authError: "" }; localStorage.removeItem("theme"); document.documentElement.classList.remove("dark"); });

test("theme switch persists the preference without clearing sign-in input", () => {
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "demo@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
  expect(screen.getByRole("img", { name: "Agentic logo" }).closest(".login-screen").dataset.theme).toBe("dark");
  expect(localStorage.getItem("theme")).toBe("dark");
  expect(screen.getByLabelText("Email address").value).toBe("demo@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
  expect(localStorage.getItem("theme")).toBe("light");
});

test("login restores the existing saved dark preference", () => {
  localStorage.setItem("theme", "dark");
  render(<LoginPage />);
  expect(screen.getByRole("button", { name: "Switch to light theme" })).not.toBeNull();
  expect(screen.getByRole("img", { name: "Agentic logo" }).closest(".login-screen").dataset.theme).toBe("dark");
});

test("login header includes the visible vector logo and product name", () => {
  render(<LoginPage />);
  const logo = screen.getByRole("img", { name: "Agentic logo" });
  expect(logo.tagName.toLowerCase()).toBe("svg");
  expect(logo.closest("header")).not.toBeNull();
  expect(logo.closest("header").textContent).toContain("agentic");
});

test("sign-in keeps the existing credentials contract and prevents duplicate submissions", async () => {
  let finish;
  login.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "demo@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic-demo-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(login).toHaveBeenCalledWith({ email: "demo@example.test", password: "synthetic-demo-password" });
  expect(screen.getByRole("button", { name: "Signing in…" }).disabled).toBe(true);
  fireEvent.submit(screen.getByLabelText("Email address").form);
  expect(login).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(screen.getByRole("button", { name: "Sign in" }).disabled).toBe(false);
});

test("password visibility and existing recovery/registration navigation remain usable", () => {
  const navigate = jest.fn();
  render(<LoginPage onNavigate={navigate} />);
  expect(screen.getByLabelText("Password").type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Show password" }));
  expect(screen.getByLabelText("Password").type).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
  expect(screen.getByLabelText("Password").type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
  fireEvent.click(screen.getByRole("button", { name: "Create an account" }));
  expect(navigate.mock.calls).toEqual([["forgot-password"], ["register"]]);
});

test("authentication errors remain visible and linked to the form controls", () => {
  state = { ...state, authError: "Sign-in details are incorrect." };
  render(<LoginPage />);
  expect(screen.getByRole("alert").textContent).toBe(state.authError);
  expect(screen.getByLabelText("Password").getAttribute("aria-describedby")).toBe("login-error");
  expect(screen.getByLabelText("Email address").required).toBe(true);
});
