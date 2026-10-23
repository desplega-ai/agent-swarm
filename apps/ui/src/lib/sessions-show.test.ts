import { describe, expect, test } from "bun:test";
import { sessionListParams, sessionTreeKey } from "../api/hooks/session-query-keys";
import {
  getSessionsHiddenSources,
  getSessionsShow,
  sessionsFilterActive,
  sessionsFilterParams,
  setSessionsHiddenSources,
  setSessionsShow,
} from "./sessions-show";

describe("sessions Mine / All view", () => {
  test("defaults to Mine, which sends no param", () => {
    expect(getSessionsShow()).toBe("mine");
    expect(sessionsFilterParams("mine", [])).toEqual({});
  });
  test("All sticks and sends show=all", () => {
    setSessionsShow("all");
    expect(getSessionsShow()).toBe("all");
    expect(sessionsFilterParams(getSessionsShow(), [])).toEqual({ show: "all" });
    setSessionsShow("mine");
    expect(getSessionsShow()).toBe("mine");
  });
});

describe("sessions hidden sources", () => {
  test("none by default, then sorted and deduplicated, with a stable array", () => {
    expect(getSessionsHiddenSources()).toEqual([]);
    setSessionsHiddenSources(["slack", "chat", "slack", ""]);
    const hidden = getSessionsHiddenSources();
    expect(hidden).toEqual(["chat", "slack"]);
    // The same array until it changes: a store snapshot must not churn.
    expect(getSessionsHiddenSources()).toBe(hidden);
    expect(sessionsFilterParams("mine", hidden)).toEqual({ hideSource: "chat,slack" });
    expect(sessionsFilterActive("mine", hidden)).toBe(true);
    setSessionsHiddenSources([]);
    expect(getSessionsHiddenSources()).toEqual([]);
    expect(sessionsFilterActive("mine", [])).toBe(false);
    expect(sessionsFilterActive("all", [])).toBe(true);
  });
  test("tree lists and the tree key follow the hidden sources; other lists do not", () => {
    setSessionsHiddenSources(["slack"]);
    expect(sessionListParams({ scope: "tree", triage: "inbox" }).hideSource).toBe("slack");
    expect(sessionListParams({ source: ["ui"] }).hideSource).toBeUndefined();
    expect(sessionTreeKey("u1", "mine")).toEqual(["session-tree", "u1", "mine", "slack"]);
    setSessionsHiddenSources([]);
    expect(sessionTreeKey("u1", "mine")).toEqual(["session-tree", "u1", "mine", ""]);
  });
});
