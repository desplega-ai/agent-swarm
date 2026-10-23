import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { sessionListParams, sessionTreeKey } from "../api/hooks/session-query-keys";
import {
  getSessionsShow,
  getSessionsShownSources,
  sessionsFilterActive,
  sessionsFilterParams,
  setSessionsShow,
  setSessionsShownSources,
} from "./sessions-show";

// A real localStorage, so "fresh storage" means no stored filter.
GlobalRegistrator.register();
beforeEach(() => localStorage.clear());
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("sessions Mine / All view", () => {
  test("defaults to Mine, which sends no param", () => {
    expect(getSessionsShow()).toBe("mine");
    expect(sessionsFilterParams("mine", ["ui"])).toEqual({ showSource: "ui" });
  });
  test("All sticks and sends show=all", () => {
    setSessionsShow("all");
    expect(getSessionsShow()).toBe("all");
    expect(sessionsFilterParams(getSessionsShow(), ["ui"])).toEqual({
      show: "all",
      showSource: "ui",
    });
    setSessionsShow("mine");
    expect(getSessionsShow()).toBe("mine");
  });
});

describe("sessions shown sources", () => {
  test("fresh storage shows only ui, so an unseen source is hidden", () => {
    expect(getSessionsShownSources()).toEqual(["ui"]);
    expect(sessionsFilterParams("mine", getSessionsShownSources())).toEqual({ showSource: "ui" });
    expect(sessionsFilterActive("mine", getSessionsShownSources())).toBe(false);
    // The server keeps only the listed sources, so github (never ticked) stays out.
    expect(sessionListParams({ scope: "tree", triage: "inbox" }).showSource).toBe("ui");
    expect(sessionTreeKey("u1", "mine")).toEqual(["session-tree", "u1", "mine", "ui"]);
  });
  test("an older hidden-sources list does not change the default", () => {
    localStorage.setItem("swarm:v1:sessions-v2:hidden-sources", "slack");
    expect(getSessionsShownSources()).toEqual(["ui"]);
  });
  test("sorted and deduplicated, with a stable array; none shown sends an empty list", () => {
    setSessionsShownSources(["slack", "ui", "slack", ""]);
    const shown = getSessionsShownSources();
    expect(shown).toEqual(["slack", "ui"]);
    // The same array until it changes: a store snapshot must not churn.
    expect(getSessionsShownSources()).toBe(shown);
    expect(sessionsFilterParams("mine", shown)).toEqual({ showSource: "slack,ui" });
    expect(sessionsFilterActive("mine", shown)).toBe(true);
    setSessionsShownSources([]);
    expect(getSessionsShownSources()).toEqual([]);
    expect(sessionsFilterParams("mine", [])).toEqual({ showSource: "" });
    expect(sessionsFilterActive("mine", [])).toBe(true);
    setSessionsShownSources(["ui"]);
    expect(sessionsFilterActive("mine", ["ui"])).toBe(false);
    expect(sessionsFilterActive("all", ["ui"])).toBe(true);
  });
  test("tree lists and the tree key follow the shown sources; other lists do not", () => {
    setSessionsShownSources(["slack", "ui"]);
    expect(sessionListParams({ scope: "tree", triage: "inbox" }).showSource).toBe("slack,ui");
    expect(sessionListParams({ source: ["ui"] }).showSource).toBeUndefined();
    expect(sessionTreeKey("u1", "mine")).toEqual(["session-tree", "u1", "mine", "slack,ui"]);
    setSessionsShownSources([]);
    expect(sessionTreeKey("u1", "mine")).toEqual(["session-tree", "u1", "mine", ""]);
  });
});
