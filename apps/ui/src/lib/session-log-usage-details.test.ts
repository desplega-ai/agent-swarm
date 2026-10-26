import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { getUsageDetails, setUsageDetails } from "./session-log-usage-details";

// A real localStorage, so "fresh storage" means no stored preference.
GlobalRegistrator.register();
beforeEach(() => {
  localStorage.clear();
  setUsageDetails(false);
  localStorage.clear();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("session log usage details", () => {
  test("off in a fresh browser", () => {
    expect(getUsageDetails()).toBe(false);
  });

  test("on sticks in this browser, and off turns it back", () => {
    setUsageDetails(true);
    expect(getUsageDetails()).toBe(true);
    expect(localStorage.getItem("swarm:v1:session-log:usage-details")).toBe("on");
    setUsageDetails(false);
    expect(getUsageDetails()).toBe(false);
  });

  test("a stored value from another tab wins over this tab's", () => {
    localStorage.setItem("swarm:v1:session-log:usage-details", "on");
    expect(getUsageDetails()).toBe(true);
  });
});
