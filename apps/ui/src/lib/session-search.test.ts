import { describe, expect, test } from "bun:test";
import {
  completeToken,
  matchingGroups,
  paletteSearchParams,
  parseSessionSearch,
  quickFilterOn,
  resolveSessionSearch,
  type SearchGroup,
  type SearchPerson,
  splitMatches,
  suggestGroups,
  suggestPeople,
  toggleQuickFilter,
  typingToken,
} from "./session-search";

const PEOPLE: SearchPerson[] = [
  { id: "u-alex", name: "Alex Demo" },
  { id: "u-lena", name: "Lena Park" },
  { id: "u-marco", name: "Marco Rossi" },
];
const GROUPS: SearchGroup[] = [
  { key: "shared/northwind/", label: "northwind" },
  { key: "shared/northwind/pricing/", label: "northwind › pricing" },
  { key: "shared/infra/", label: "infra" },
  { key: "personal/u-lena/notes/", label: "Lena Park › notes" },
];
const resolve = (text: string) =>
  resolveSessionSearch(parseSessionSearch(text), { people: PEOPLE, groups: GROUPS });

describe("parseSessionSearch", () => {
  test("splits free words from tokens", () => {
    const parsed = parseSessionSearch("  price feed with:Lena in:pricing is:unread ");
    expect(parsed.words).toEqual(["price", "feed"]);
    expect(parsed.with).toEqual(["lena"]);
    expect(parsed.in).toEqual(["pricing"]);
    expect(parsed.is).toEqual(["unread"]);
    expect(parsed.empty).toBe(false);
  });

  test("a token value may follow after a space", () => {
    expect(parseSessionSearch("with: lena").with).toEqual(["lena"]);
    // The next word is itself a token, so it is not the value.
    const parsed = parseSessionSearch("with: is:later");
    expect(parsed.with).toEqual([]);
    expect(parsed.partial).toBe("with");
    expect(parsed.is).toEqual(["later"]);
  });

  test("keys are case-insensitive and unknown is: values are kept as bad", () => {
    const parsed = parseSessionSearch("IS:Running is:foo");
    expect(parsed.is).toEqual(["running"]);
    expect(parsed.bad).toEqual(["is:foo"]);
  });

  test("a bare token at the end waits", () => {
    expect(parseSessionSearch("in:").partial).toBe("in");
    expect(parseSessionSearch("").empty).toBe(true);
  });
});

describe("resolveSessionSearch", () => {
  test("free text goes to q", () => {
    expect(resolve("price feed")).toEqual({ ok: true, params: { q: "price feed" } });
  });

  test("with: resolves a name to a user id, by any word of the name", () => {
    expect(resolve("with:lena")).toEqual({ ok: true, params: { withUserId: "u-lena" } });
    expect(resolve("with:rossi")).toEqual({ ok: true, params: { withUserId: "u-marco" } });
    expect(resolve("with:nobody")).toEqual({
      ok: false,
      message: "No person matches with:nobody.",
    });
  });

  test("in: takes the exact group name first, the parent over a deeper path", () => {
    expect(resolve("in:pricing")).toEqual({
      ok: true,
      params: { keyPrefix: "shared/northwind/pricing/" },
    });
    expect(resolve("in:northwind")).toEqual({
      ok: true,
      params: { keyPrefix: "shared/northwind/" },
    });
    expect(resolve("in:pric")).toEqual({
      ok: true,
      params: { keyPrefix: "shared/northwind/pricing/" },
    });
    expect(resolve("in:notes")).toEqual({
      ok: true,
      params: { keyPrefix: "personal/u-lena/notes/" },
    });
    expect(resolve("in:legal")).toEqual({ ok: false, message: "No group matches in:legal." });
  });

  test("is: maps to the triage and status filters", () => {
    expect(resolve("is:unread")).toEqual({ ok: true, params: { triage: "unread" } });
    expect(resolve("is:later")).toEqual({ ok: true, params: { triage: "later" } });
    expect(resolve("is:done")).toEqual({ ok: true, params: { triage: "done" } });
    expect(resolve("is:running")).toEqual({ ok: true, params: { status: "running" } });
    expect(resolve("is:needs")).toEqual({ ok: true, params: { status: "needs" } });
    expect(resolve("is:needs is:running")).toMatchObject({ ok: false });
    expect(resolve("with:alex is:unread is:running")).toEqual({
      ok: true,
      params: { withUserId: "u-alex", triage: "unread", status: "running" },
    });
  });

  test("refuses what the server cannot answer, with one sentence", () => {
    expect(resolve("is:later is:done")).toMatchObject({ ok: false });
    expect(resolve("with:lena with:marco")).toEqual({
      ok: false,
      message: "Search for one person at a time.",
    });
    expect(resolve("in:infra in:pricing")).toEqual({
      ok: false,
      message: "Search in one group at a time.",
    });
    expect(resolve("is:soon")).toEqual({
      ok: false,
      message:
        "is:soon is not a filter. Try is:unread, is:running, is:needs, is:later, or is:done.",
    });
    expect(resolve("with:")).toEqual({ ok: false, message: "Type a name, like with:lena." });
  });

  test("a bare token after a real filter does not block the search", () => {
    expect(resolve("feed with:")).toEqual({ ok: true, params: { q: "feed" } });
  });
});

describe("matchingGroups", () => {
  test("a group matches when its path holds every free word", () => {
    const keys = (text: string) =>
      matchingGroups(parseSessionSearch(text), GROUPS).map((group) => group.key);
    expect(keys("north")).toEqual(["shared/northwind/", "shared/northwind/pricing/"]);
    expect(keys("pricing north")).toEqual(["shared/northwind/pricing/"]);
    expect(keys("is:unread")).toEqual([]);
  });
});

describe("paletteSearchParams", () => {
  const lookups = { people: PEOPLE, groups: GROUPS };
  test("the palette text uses the same tokens as the sidebar search", () => {
    expect(paletteSearchParams("with:lena", lookups)).toEqual({ withUserId: "u-lena" });
    expect(paletteSearchParams("feed in:pricing is:unread", lookups)).toEqual({
      q: "feed",
      keyPrefix: "shared/northwind/pricing/",
      triage: "unread",
    });
  });
  test("empty or impossible text asks for nothing", () => {
    expect(paletteSearchParams("   ", lookups)).toBeNull();
    expect(paletteSearchParams("with:nobody", lookups)).toBeNull();
  });
});

describe("splitMatches", () => {
  test("marks every match of every free word, in any case", () => {
    expect(splitMatches("Price feed for the PRICE list", ["price"])).toEqual([
      { text: "Price", match: true },
      { text: " feed for the ", match: false },
      { text: "PRICE", match: true },
      { text: " list", match: false },
    ]);
    expect(splitMatches("a.b (c)", ["(c)", "a."])).toEqual([
      { text: "a.", match: true },
      { text: "b ", match: false },
      { text: "(c)", match: true },
    ]);
  });
  test("no words: one plain piece", () => {
    expect(splitMatches("Hi there", [])).toEqual([{ text: "Hi there", match: false }]);
  });
});

describe("status bar quick filters", () => {
  test("a toggle adds its token, replaces another quick filter, and keeps the rest", () => {
    expect(toggleQuickFilter("", "unread")).toBe("is:unread");
    expect(toggleQuickFilter("pricing with:Lena is:running", "unread")).toBe(
      "pricing with:Lena is:unread",
    );
    expect(toggleQuickFilter("pricing IS:Unread", "unread")).toBe("pricing");
    expect(quickFilterOn("pricing is:unread", "unread")).toBe(true);
    expect(quickFilterOn("pricing", "unread")).toBe(false);
  });

  test("a toggle leaves other is: tokens and a waiting token as typed", () => {
    expect(toggleQuickFilter("is:soon feed in:", "unread")).toBe("is:soon feed in: is:unread");
    expect(toggleQuickFilter("is:later Feed is:unread", "unread")).toBe("is:later Feed");
  });
});

describe("phone token suggestions", () => {
  test("typingToken finds a with: or in: token at the end", () => {
    expect(typingToken("with:")).toEqual({ kind: "with", value: "", start: 0 });
    expect(typingToken("pricing with: Le")).toEqual({ kind: "with", value: "le", start: 8 });
    expect(typingToken("in:pri")).toEqual({ kind: "in", value: "pri", start: 0 });
    // A token that ends with a space is done; a free word is no token.
    expect(typingToken("with:lena ")).toBeNull();
    expect(typingToken("pricing")).toBeNull();
    expect(typingToken("is:unread")).toBeNull();
  });

  test("completeToken replaces the token and leaves room for the next word", () => {
    const text = "is:unread with: le";
    const token = typingToken(text);
    if (!token) throw new Error("no token");
    expect(completeToken(text, token, "lena")).toBe("is:unread with:lena ");
  });

  test("suggestPeople matches a name word and keeps tokens apart", () => {
    const people = [
      { id: "aaaaaaaa-1", name: "Alex Demo" },
      { id: "bbbbbbbb-2", name: "Morgan Demo" },
      { id: "cccccccc-3", name: "Alex Stone" },
    ];
    expect(suggestPeople("mor", people).map((s) => s.value)).toEqual(["morgan"]);
    expect(suggestPeople("demo", people).map((s) => s.label)).toEqual(["Alex Demo", "Morgan Demo"]);
    // Two people named Alex: the token is the id prefix, which the search also reads.
    expect(suggestPeople("alex", people).map((s) => s.value)).toEqual(["aaaaaaaa", "cccccccc"]);
    expect(suggestPeople("", people)).toHaveLength(3);
  });

  test("suggestGroups matches the path and completes with the last name", () => {
    const groups = [
      { key: "shared/northwind/", label: "northwind" },
      { key: "shared/northwind/pricing/", label: "northwind › pricing" },
    ];
    expect(suggestGroups("pri", groups)).toEqual([
      { id: "shared/northwind/pricing/", label: "northwind › pricing", value: "pricing" },
    ]);
    expect(suggestGroups("north", groups).map((s) => s.value)).toEqual(["northwind", "pricing"]);
  });

  test("a completed token resolves to the suggested person and group", () => {
    const people = [{ id: "bbbbbbbb-2", name: "Morgan Demo" }];
    const groups = [{ key: "shared/northwind/pricing/", label: "northwind › pricing" }];
    const result = resolveSessionSearch(parseSessionSearch("with:morgan in:pricing"), {
      people,
      groups,
    });
    expect(result).toEqual({
      ok: true,
      params: { withUserId: "bbbbbbbb-2", keyPrefix: "shared/northwind/pricing/" },
    });
  });
});
