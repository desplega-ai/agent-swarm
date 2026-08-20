import { describe, expect, test } from "bun:test";
import { getUserCommsPrefs } from "../utils/requester-comms";

describe("getUserCommsPrefs", () => {
  test("returns undefined for missing user or metadata", () => {
    expect(getUserCommsPrefs(undefined)).toBeUndefined();
    expect(getUserCommsPrefs({ metadata: undefined })).toBeUndefined();
    expect(getUserCommsPrefs({ metadata: {} })).toBeUndefined();
  });

  test("returns undefined when comms is not an object", () => {
    expect(getUserCommsPrefs({ metadata: { comms: "casual" } })).toBeUndefined();
    expect(getUserCommsPrefs({ metadata: { comms: ["casual"] } })).toBeUndefined();
    expect(getUserCommsPrefs({ metadata: { comms: null } })).toBeUndefined();
  });

  test("picks trimmed string fields and drops the rest", () => {
    expect(
      getUserCommsPrefs({
        metadata: {
          comms: { tone: "  casual  ", language: "uk", verbosity: 3, extra: "ignored" },
        },
      }),
    ).toEqual({ tone: "casual", language: "uk", verbosity: undefined });
  });

  test("returns undefined when all comms fields are empty or non-string", () => {
    expect(
      getUserCommsPrefs({ metadata: { comms: { tone: "   ", language: 7 } } }),
    ).toBeUndefined();
  });
});
