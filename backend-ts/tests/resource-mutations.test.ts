import { expect, test } from "vitest";
import { ResourceMutations } from "../src/http/resource-mutations.js";

test("unrelated resources progress while one mutation waits; same resource stays ordered", async () => {
  const locks = new ResourceMutations(), events: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = locks.run("chat:a", async () => { events.push("a:start"); await held; events.push("a:end"); });
  const second = locks.run("chat:a", async () => { events.push("a:second"); });
  await locks.run("chat:b", async () => { events.push("b:done"); });
  expect(events).toEqual(["a:start", "b:done"]);
  release(); await Promise.all([first, second]);
  expect(events).toEqual(["a:start", "b:done", "a:end", "a:second"]);
  expect(locks.pendingResources).toBe(0);
});

test("failed mutations release their resource lock", async () => {
  const locks = new ResourceMutations();
  await expect(locks.run("workflow:a", async () => { throw new Error("failure"); })).rejects.toThrow();
  await expect(locks.run("workflow:a", async () => "next")).resolves.toBe("next");
  expect(locks.pendingResources).toBe(0);
});
