import { describe, expect, test } from "bun:test";
import { rng } from "../../scripts/bench-boot-scrub-corpus";
import { LiteralMatcher } from "../utils/literal-matcher";
import { GITLEAKS_RULES } from "../utils/secret-rules.generated";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function found(matcher: LiteralMatcher, text: string, size: number): number[] {
  const flags = new Uint8Array(size);
  matcher.collect(text, flags);
  return [...flags.keys()].filter((id) => flags[id]);
}

describe("LiteralMatcher", () => {
  test("finds every pattern a case-insensitive regex finds, and no other", () => {
    const patterns = [...new Set(GITLEAKS_RULES.rules.flatMap((r) => r.keywords))];
    const matcher = new LiteralMatcher(patterns);
    const regexes = patterns.map((p) => new RegExp(escapeRe(p), "i"));
    const rand = rng(11);
    // Characters that fold onto ASCII under toLowerCase/toUpperCase but not under a `/i` regex.
    const noise = ["İ", "ı", "ſ", "K", "é", "\u0000", "\n", "-", "_", ".", "A", "z", "9"];
    const pieces = [...patterns, ...noise];
    for (let i = 0; i < 3000; i++) {
      let text = "";
      for (let n = Math.floor(rand() * 12); n > 0; n--) {
        const piece = pieces[Math.floor(rand() * pieces.length)] as string;
        text += rand() < 0.4 ? piece.toUpperCase() : piece;
      }
      const expected = regexes.flatMap((re, id) => (re.test(text) ? [id] : []));
      expect(found(matcher, text, patterns.length), JSON.stringify(text)).toEqual(expected);
    }
  });

  test("a pattern that is the end of a longer one is reported with it", () => {
    const matcher = new LiteralMatcher(["he", "she", "his", "hers"]);
    expect(found(matcher, "ushers", 4)).toEqual([0, 1, 3]);
  });

  test("has() stops at the first hit and reads a non-ASCII character as no match", () => {
    const matcher = new LiteralMatcher(["token="]);
    expect(matcher.has("x TOKEN=1")).toBe(true);
    expect(matcher.has("tokén=1")).toBe(false);
    expect(matcher.has("token")).toBe(false);
  });

  test("skip ignores the listed characters in the text", () => {
    const matcher = new LiteralMatcher(["apikey="], { skip: "_.-" });
    for (const text of ["api_key=", "API-KEY=", "a.p.i.k.e.y=", "x_apiKey="]) {
      expect(matcher.has(text), text).toBe(true);
    }
    expect(matcher.has("api key=")).toBe(false);
    expect(() => new LiteralMatcher(["api_key"], { skip: "_" })).toThrow();
  });

  test("rejects a non-ASCII pattern", () => {
    expect(() => new LiteralMatcher(["tokén"])).toThrow(/unsupported/);
  });
});
