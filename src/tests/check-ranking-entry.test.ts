import { describe, expect, test } from "bun:test";
import {
  checkRankingEntries,
  type Entry,
  isEntryPath,
  parseEntry,
  type Verification,
} from "../../scripts/check-ranking-entry";

const CLAIM = "rk_3f9a1c0e7b2d4a6f8e1c3b5d7f9a2c4e";
const OTHER_CLAIM = "rk_00000000000000000000000000000001";
const file = (domain: string, claim = CLAIM) =>
  JSON.stringify({ $schema: "./schema.json", domain, claim });

const VERIFIED: Verification = {
  verified: true,
  reasons: [],
  telemetryActive7d: true,
  websiteMatchesDomain: true,
  listing: {
    name: "Acme",
    domain: "acme.dev",
    category: "engineering",
    subcategory: "qa-testing",
    description: "QA | release automation",
    sourceCodeUrl: null,
  },
};

describe("parseEntry", () => {
  test("accepts the opt-in file", () => {
    expect(parseEntry("acme.dev.json", file("acme.dev"))).toEqual({
      domain: "acme.dev",
      claim: CLAIM,
    });
  });

  test.each([
    ["acme.dev.json", "{", "valid JSON"],
    ["acme.dev.json", "[]", "JSON object"],
    [
      "acme.dev.json",
      JSON.stringify({ domain: "acme.dev", claim: CLAIM, name: "Acme" }),
      "unknown keys",
    ],
    ["www.acme.dev.json", file("www.acme.dev"), "bare lowercase hostname"],
    ["Acme.ba.json", file("Acme.ba"), "bare lowercase hostname"],
    ["other.ba.json", file("acme.dev"), "must be named acme.dev.json"],
    ["acme.dev.json", file("acme.dev", "rk_short"), "claim"],
  ])("rejects %s %s", (name, text, message) => {
    expect(() => parseEntry(name, text)).toThrow(message);
  });

  test("README and schema are not entries", () => {
    expect(isEntryPath("community/ranking/acme.dev.json")).toBe(true);
    expect(isEntryPath("community/ranking/schema.json")).toBe(false);
    expect(isEntryPath("community/ranking/README.md")).toBe(false);
    expect(isEntryPath("community/ranking/nested/acme.dev.json")).toBe(false);
  });
});

describe("checkRankingEntries", () => {
  const files: Record<string, string> = {
    "community/ranking/acme.dev.json": file("acme.dev"),
    "community/ranking/acme.com.json": file("acme.com", CLAIM),
  };
  const run = (
    paths: string[],
    verify: (entry: Entry) => Promise<Verification>,
    all = ["acme.dev.json"],
  ) =>
    checkRankingEntries({
      changes: paths.map((path) => ({ status: "A", path })),
      readEntry: (path) => files[path] ?? "",
      allEntries: all.map((name) => [name, files[`community/ranking/${name}`] ?? ""]),
      verify,
    });

  test("a verified entry passes and the summary shows the listing", async () => {
    const asked: Entry[] = [];
    const result = await run(["community/ranking/acme.dev.json"], async (entry) => {
      asked.push(entry);
      return VERIFIED;
    });
    expect(result.problems).toEqual([]);
    expect(asked).toEqual([{ domain: "acme.dev", claim: CLAIM }]);
    const summary = result.summary.join("\n");
    expect(summary).toContain("### acme.dev: verified");
    expect(summary).toContain(
      "| Acme | engineering | qa-testing | QA \\| release automation | — |",
    );
  });

  test("an unverified entry fails with the proxy's reasons", async () => {
    const result = await run(["community/ranking/acme.dev.json"], async () => ({
      ...VERIFIED,
      verified: false,
      reasons: ["telemetry_inactive_7d"],
    }));
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("telemetry_inactive_7d");
  });

  test("a proxy error fails without throwing", async () => {
    const result = await run(["community/ranking/acme.dev.json"], async () => {
      throw new Error("the proxy answered 503");
    });
    expect(result.problems[0]).toContain("503");
  });

  test("a claim shared with another entry fails before verify", async () => {
    let called = false;
    const result = await run(["community/ranking/acme.com.json"], async () => {
      called = true;
      return VERIFIED;
    }, ["acme.dev.json", "acme.com.json"]);
    expect(called).toBe(false);
    expect(result.problems[0]).toContain("acme.dev.json");
  });

  test("a removal needs no proof, and README edits are ignored", async () => {
    const result = await checkRankingEntries({
      changes: [
        { status: "D", path: "community/ranking/acme.dev.json" },
        { status: "M", path: "community/ranking/README.md" },
      ],
      readEntry: () => "",
      allEntries: [],
      verify: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result.problems).toEqual([]);
    expect(result.summary).toEqual(["- Removed `acme.dev.json`."]);
  });

  test("the claim differs per entry in a valid two-entry PR", async () => {
    files["community/ranking/acme.com.json"] = file("acme.com", OTHER_CLAIM);
    const result = await run(
      ["community/ranking/acme.com.json", "community/ranking/acme.dev.json"],
      async () => VERIFIED,
      ["acme.dev.json", "acme.com.json"],
    );
    expect(result.problems).toEqual([]);
  });
});
