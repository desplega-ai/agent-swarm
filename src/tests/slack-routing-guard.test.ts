import { describe, expect, test } from "bun:test";
import { linearContextKey, slackContextKey } from "../tasks/context-key";
import { checkSlackRoutingCoherence, slackChannelFromContextKey } from "../tasks/slack-routing";

describe("slackChannelFromContextKey", () => {
  test("extracts channel/thread from a slack-family key", () => {
    const key = slackContextKey({ channelId: "C_ABC", threadTs: "111.222" });
    expect(slackChannelFromContextKey(key)).toEqual({ channelId: "C_ABC", threadTs: "111.222" });
  });

  test("returns null for a non-slack family key", () => {
    const key = linearContextKey({ issueIdentifier: "DES-42" });
    expect(slackChannelFromContextKey(key)).toBeNull();
  });

  test("returns null for a malformed key instead of throwing", () => {
    expect(slackChannelFromContextKey("not-a-context-key")).toBeNull();
  });

  test("returns null for undefined/null input", () => {
    expect(slackChannelFromContextKey(undefined)).toBeNull();
    expect(slackChannelFromContextKey(null)).toBeNull();
  });
});

describe("checkSlackRoutingCoherence", () => {
  test("no explicit unit → ok (nothing to check)", () => {
    const result = checkSlackRoutingCoherence({ explicit: {} });
    expect(result.verdict).toBe("ok");
  });

  test("channel without threadTs → partial-unit", () => {
    const result = checkSlackRoutingCoherence({ explicit: { channelId: "C_A" } });
    expect(result.verdict).toBe("partial-unit");
  });

  test("threadTs without channel → partial-unit", () => {
    const result = checkSlackRoutingCoherence({ explicit: { threadTs: "111.222" } });
    expect(result.verdict).toBe("partial-unit");
  });

  test("userId alone (no channel/thread) → ok — attribution only", () => {
    const result = checkSlackRoutingCoherence({ explicit: { userId: "U_SOMEONE" } });
    expect(result.verdict).toBe("ok");
  });

  test("no parent, no contextKey → complete explicit unit accepted (new Slack root)", () => {
    const result = checkSlackRoutingCoherence({
      explicit: { channelId: "C_NEW", threadTs: "111.222" },
    });
    expect(result.verdict).toBe("ok");
  });

  test("explicit unit matches parent's slackChannelId → ok", () => {
    const result = checkSlackRoutingCoherence({
      explicit: { channelId: "C_PARENT", threadTs: "111.222" },
      parent: { slackChannelId: "C_PARENT", slackThreadTs: "999.999", contextKey: null },
    });
    expect(result.verdict).toBe("ok");
  });

  test("explicit channelId mismatches parent's slackChannelId → mismatch (source: parent)", () => {
    const result = checkSlackRoutingCoherence({
      explicit: { channelId: "C_WRONG", threadTs: "111.222" },
      parent: { slackChannelId: "C_PARENT", slackThreadTs: "999.999", contextKey: null },
    });
    expect(result.verdict).toBe("mismatch");
    if (result.verdict === "mismatch") {
      expect(result.field).toBe("slackChannelId");
      expect(result.expectedSource).toBe("parent");
      expect(result.expected).toBe("C_PARENT");
      expect(result.got).toBe("C_WRONG");
    }
  });

  test("explicit channelId mismatches the inherited slack contextKey → mismatch (source: contextKey)", () => {
    const contextKey = slackContextKey({ channelId: "C_GEROLD", threadTs: "111.222" });
    const result = checkSlackRoutingCoherence({
      explicit: { channelId: "C_DANIEL", threadTs: "111.222" },
      inheritedContextKey: contextKey,
    });
    expect(result.verdict).toBe("mismatch");
    if (result.verdict === "mismatch") {
      expect(result.field).toBe("slackChannelId");
      expect(result.expectedSource).toBe("contextKey");
      expect(result.expected).toBe("C_GEROLD");
      expect(result.got).toBe("C_DANIEL");
    }
  });

  test("explicit threadTs mismatches the inherited slack contextKey's thread → mismatch", () => {
    const contextKey = slackContextKey({ channelId: "C_GEROLD", threadTs: "111.222" });
    const result = checkSlackRoutingCoherence({
      explicit: { channelId: "C_GEROLD", threadTs: "333.444" },
      inheritedContextKey: contextKey,
    });
    expect(result.verdict).toBe("mismatch");
    if (result.verdict === "mismatch") {
      expect(result.field).toBe("slackThreadTs");
      expect(result.expectedSource).toBe("contextKey");
      expect(result.expected).toBe("111.222");
      expect(result.got).toBe("333.444");
    }
  });

  test("incident replay: explicit unit disagrees with BOTH parent and contextKey → rejects on parent first", () => {
    const contextKey = slackContextKey({ channelId: "D0ATCHCQR4M", threadTs: "1783596696.921879" });
    const result = checkSlackRoutingCoherence({
      explicit: { channelId: "D0ASZJS6HUN", threadTs: "1783596696.921879" },
      parent: { slackChannelId: "D0ATCHCQR4M", slackThreadTs: "1783596696.921879", contextKey },
      inheritedContextKey: contextKey,
    });
    expect(result.verdict).toBe("mismatch");
    if (result.verdict === "mismatch") {
      expect(result.expectedSource).toBe("parent");
      expect(result.expected).toBe("D0ATCHCQR4M");
      expect(result.got).toBe("D0ASZJS6HUN");
    }
  });

  test("parent has non-slack contextKey → only parent-field comparison applies, unit accepted", () => {
    const result = checkSlackRoutingCoherence({
      explicit: { channelId: "C_NEW", threadTs: "111.222" },
      parent: {
        slackChannelId: null,
        slackThreadTs: null,
        contextKey: linearContextKey({ issueIdentifier: "DES-1" }),
      },
      inheritedContextKey: linearContextKey({ issueIdentifier: "DES-1" }),
    });
    expect(result.verdict).toBe("ok");
  });

  test("malformed inherited contextKey degrades to parent-only comparison, no throw", () => {
    const result = checkSlackRoutingCoherence({
      explicit: { channelId: "C_PARENT", threadTs: "111.222" },
      parent: { slackChannelId: "C_PARENT", slackThreadTs: "999.999", contextKey: "garbage" },
      inheritedContextKey: "garbage",
    });
    expect(result.verdict).toBe("ok");
  });

  test("explicit unit identical to parent's (verbatim-copy pattern) → ok, no behavior change", () => {
    const result = checkSlackRoutingCoherence({
      explicit: { channelId: "C_SAME", threadTs: "111.222", userId: "U_SAME" },
      parent: { slackChannelId: "C_SAME", slackThreadTs: "111.222", contextKey: null },
    });
    expect(result.verdict).toBe("ok");
  });
});
