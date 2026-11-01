import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { deriveStorageKey } from "../hooks/use-dismissible-card-key";
import { allUsersScopeEnabled, setAllUsersScope } from "./all-users-scope";
import { CURRENT_USER_CARD_KEY } from "./dashboard-user";

GlobalRegistrator.register();
beforeEach(() => localStorage.clear());
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const operator = { apiUrl: "https://api.example.test", apiKey: "operator-key" };
const pick = (userId: string) =>
  localStorage.setItem(deriveStorageKey(operator.apiUrl, CURRENT_USER_CARD_KEY), userId);

describe("all-users read scope opt-in", () => {
  test("is off by default", () => {
    pick("user-a");
    expect(allUsersScopeEnabled(operator)).toBe(false);
  });

  test("sticks per picked user, so another identity starts off", () => {
    pick("user-a");
    setAllUsersScope(operator, true);
    expect(allUsersScopeEnabled(operator)).toBe(true);
    pick("user-b");
    expect(allUsersScopeEnabled(operator)).toBe(false);
    pick("user-a");
    setAllUsersScope(operator, false);
    expect(allUsersScopeEnabled(operator)).toBe(false);
  });

  test("is per API", () => {
    pick("user-a");
    setAllUsersScope(operator, true);
    expect(allUsersScopeEnabled({ ...operator, apiUrl: "https://other.example.test" })).toBe(false);
  });
});
