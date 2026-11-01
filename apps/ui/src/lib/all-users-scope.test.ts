import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { deriveStorageKey } from "../hooks/use-dismissible-card-key";
import {
  allUsersScopeEnabled,
  allUsersScopeKey,
  bindAllUsersScopeCache,
  noteAllUsersScopeUserSwitch,
  setAllUsersScope,
} from "./all-users-scope";
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

  test("is per user token: one token's opt-in never carries to another", () => {
    const tokenA = { apiUrl: operator.apiUrl, apiKey: "aswt_admin-a-secret-wxyz" };
    const tokenB = { apiUrl: operator.apiUrl, apiKey: "aswt_admin-b-secret-wxyz" };
    setAllUsersScope(tokenA, true);
    expect(allUsersScopeEnabled(tokenA)).toBe(true);
    expect(allUsersScopeEnabled(tokenB)).toBe(false);
    // Nor to the bare operator key, which picks no user.
    expect(allUsersScopeEnabled(operator)).toBe(false);
    // The storage key never carries the raw token.
    expect(allUsersScopeKey(tokenA)).not.toContain("secret");
    expect(Object.keys(localStorage).join("\n")).not.toContain("secret");
  });
});

describe("all-users read scope across tabs", () => {
  const admin = { apiUrl: operator.apiUrl, apiKey: "aswt_admin-a-secret" };

  // Another tab writes storage; the browser then fires `storage` in this tab.
  const otherTab = (on: boolean) => {
    const key = allUsersScopeKey(admin);
    const oldValue = localStorage.getItem(key);
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue: on ? "1" : null }));
  };

  const cachedClient = () => {
    const client = new QueryClient();
    client.setQueryData(["tasks", "list"], ["someone else's private task"]);
    client.setQueryData(["whoami", "session-read-all"], { sessionReadAll: true });
    return client;
  };

  test("an opt-out in another tab turns the scope off here and drops cached results", async () => {
    const client = cachedClient();
    const unbind = bindAllUsersScopeCache(client);
    try {
      setAllUsersScope(admin, true);
      expect(allUsersScopeEnabled(admin)).toBe(true);
      client.setQueryData(["tasks", "list"], ["someone else's private task"]);

      otherTab(false);
      expect(allUsersScopeEnabled(admin)).toBe(false);
      await Promise.resolve();
      expect(client.getQueryData(["tasks", "list"])).toBeUndefined();
      // whoami does not depend on the scope; the toggle stays put.
      expect(client.getQueryData(["whoami", "session-read-all"])).toEqual({
        sessionReadAll: true,
      });
    } finally {
      unbind();
    }
  });

  test("an opt-in in another tab turns the scope on here and drops cached results", async () => {
    const client = cachedClient();
    const unbind = bindAllUsersScopeCache(client);
    try {
      expect(allUsersScopeEnabled(admin)).toBe(false);
      otherTab(true);
      expect(allUsersScopeEnabled(admin)).toBe(true);
      await Promise.resolve();
      expect(client.getQueryData(["tasks", "list"])).toBeUndefined();
    } finally {
      unbind();
    }
  });

  test("a change in this tab drops cached results too; unrelated storage keys do not", async () => {
    const client = cachedClient();
    const unbind = bindAllUsersScopeCache(client);
    try {
      window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "x" }));
      await Promise.resolve();
      expect(client.getQueryData(["tasks", "list"])).toEqual(["someone else's private task"]);
      setAllUsersScope(admin, true);
      await Promise.resolve();
      expect(client.getQueryData(["tasks", "list"])).toBeUndefined();
    } finally {
      unbind();
    }
  });
});

describe("all-users read scope on a picked-user switch", () => {
  test("a switch away from a user who had it on drops cached results; between two users without it, nothing drops", async () => {
    const client = new QueryClient();
    const unbind = bindAllUsersScopeCache(client);
    try {
      pick("user-a");
      setAllUsersScope(operator, true);
      client.setQueryData(["tasks", "list"], ["someone else's private task"]);
      pick("user-b");
      noteAllUsersScopeUserSwitch(operator, "user-a", "user-b");
      await Promise.resolve();
      expect(client.getQueryData(["tasks", "list"])).toBeUndefined();
      expect(allUsersScopeEnabled(operator)).toBe(false);

      client.setQueryData(["tasks", "list"], ["user-b's task"]);
      pick("user-c");
      noteAllUsersScopeUserSwitch(operator, "user-b", "user-c");
      await Promise.resolve();
      expect(client.getQueryData(["tasks", "list"])).toEqual(["user-b's task"]);
    } finally {
      unbind();
    }
  });
});
