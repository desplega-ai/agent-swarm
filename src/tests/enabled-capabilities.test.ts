import { afterEach, expect, test } from "bun:test";
import { ALL_CAPABILITIES, getEnabledCapabilities, hasCapability } from "../server";

const originalCapabilities = process.env.CAPABILITIES;

afterEach(() => {
  if (originalCapabilities === undefined) delete process.env.CAPABILITIES;
  else process.env.CAPABILITIES = originalCapabilities;
});

// `services` was a real capability until the PM2 service registry was removed.
// A deployment that still lists it must keep registering agents: the register
// response validates enabledCapabilities against ALL_CAPABILITIES.
test("enabledCapabilities drops retired and free-form names", () => {
  process.env.CAPABILITIES = "core,services,artifacts,pages";

  expect(ALL_CAPABILITIES as readonly string[]).not.toContain("services");
  expect(getEnabledCapabilities()).toEqual(["core", "pages"]);
  expect(hasCapability("pages")).toBe(true);
});
