import {
  buildContextFooter,
  contextKeyPrefix,
  newSessionContextKey,
  sessionLabel,
  stripContextFooter,
  withContextFooter,
} from "./model";

describe("context keys", () => {
  test("new session keys add exactly one part under the page key", () => {
    const key = newSessionContextKey("task:ui:workflow:w1");
    expect(key.startsWith(contextKeyPrefix("task:ui:workflow:w1"))).toBe(true);
    expect(key.split(":")).toHaveLength(5);
    expect(newSessionContextKey("task:ui:workflow:w1")).not.toBe(key);
  });

  test("the prefix keeps a trailing `:` so w1 never matches w12", () => {
    expect(contextKeyPrefix("task:ui:workflow:w1")).toBe("task:ui:workflow:w1:");
    expect(newSessionContextKey("task:ui:workflow:w12").startsWith("task:ui:workflow:w1:")).toBe(
      false,
    );
  });
});

describe("context footer", () => {
  const footer = buildContextFooter(
    [
      ["URL", "https://x/y"],
      ["Entity", undefined],
      ["Title", ""],
    ],
    "swarm UI",
  );

  test("drops empty fields", () => {
    expect(footer).toBe("---\nPage context (swarm UI)\n- URL: https://x/y");
  });

  test("round-trips through with/strip", () => {
    const text = withContextFooter("fix the chart\nsecond line", footer);
    expect(text).toBe(`fix the chart\nsecond line\n\n${footer}`);
    expect(stripContextFooter(text)).toBe("fix the chart\nsecond line");
  });

  test("leaves text without a footer alone, including a user's own `---`", () => {
    expect(stripContextFooter("a\n---\nb")).toBe("a\n---\nb");
    expect(withContextFooter("a", undefined)).toBe("a");
  });

  test("strips a footer with no surface label", () => {
    expect(stripContextFooter(`hi\n\n${buildContextFooter([["URL", "u"]])}`)).toBe("hi");
  });
});

describe("sessionLabel", () => {
  test("prefers the custom title", () => {
    expect(sessionLabel({ title: " Renamed ", task: "typed" })).toBe("Renamed");
  });

  test("uses the first typed line without the footer", () => {
    const text = withContextFooter("\nfirst\nsecond", buildContextFooter([["URL", "u"]]));
    expect(sessionLabel({ task: text })).toBe("first");
  });

  test("uses the list's slim taskPreview when present, and truncates", () => {
    expect(sessionLabel({ task: "", taskPreview: "x".repeat(100) }, 10)).toBe(`${"x".repeat(9)}…`);
  });
});
