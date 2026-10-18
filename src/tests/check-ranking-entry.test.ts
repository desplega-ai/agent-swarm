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
    name: "Imtec",
    domain: "imtec.ba",
    category: "engineering",
    subcategory: "qa-testing",
    description: "QA | release automation",
    sourceCodeUrl: null,
  },
};

describe("parseEntry", () => {
  test("accepts the opt-in file", () => {
    expect(parseEntry("imtec.ba.json", file("imtec.ba"))).toEqual({
      domain: "imtec.ba",
      claim: CLAIM,
    });
  });

  test.each([
    ["imtec.ba.json", "{", "valid JSON"],
    ["imtec.ba.json", "[]", "JSON object"],
    [
      "imtec.ba.json",
      JSON.stringify({ domain: "imtec.ba", claim: CLAIM, name: "Imtec" }),
      "unknown keys",
    ],
    ["www.imtec.ba.json", file("www.imtec.ba"), "bare lowercase hostname"],
    ["Imtec.ba.json", file("Imtec.ba"), "bare lowercase hostname"],
    ["other.ba.json", file("imtec.ba"), "must be named imtec.ba.json"],
    ["imtec.ba.json", file("imtec.ba", "rk_short"), "claim"],
  ])("rejects %s %s", (name, text, message) => {
    expect(() => parseEntry(name, text)).toThrow(message);
  });

  test("README and schema are not entries", () => {
    expect(isEntryPath("community/ranking/imtec.ba.json")).toBe(true);
    expect(isEntryPath("community/ranking/schema.json")).toBe(false);
    expect(isEntryPath("community/ranking/README.md")).toBe(false);
    expect(isEntryPath("community/ranking/nested/imtec.ba.json")).toBe(false);
  });
});

describe("checkRankingEntries", () => {
  const files: Record<string, string> = {
    "community/ranking/imtec.ba.json": file("imtec.ba"),
    "community/ranking/acme.com.json": file("acme.com", CLAIM),
  };
  const run = (
    paths: string[],
    verify: (entry: Entry) => Promise<Verification>,
    all = ["imtec.ba.json"],
  ) =>
    checkRankingEntries({
      changes: paths.map((path) => ({ status: "A", path })),
      readEntry: (path) => files[path] ?? "",
      allEntries: all.map((name) => [name, files[`community/ranking/${name}`] ?? ""]),
      verify,
    });

  test("a verified entry passes and the summary shows the listing", async () => {
    const asked: Entry[] = [];
    const result = await run(["community/ranking/imtec.ba.json"], async (entry) => {
      asked.push(entry);
      return VERIFIED;
    });
    expect(result.problems).toEqual([]);
    expect(asked).toEqual([{ domain: "imtec.ba", claim: CLAIM }]);
    const summary = result.summary.join("\n");
    expect(summary).toContain("### imtec.ba: verified");
    expect(summary).toContain(
      "| Imtec | engineering | qa-testing | QA \\| release automation | — |",
    );
  });

  test("an unverified entry fails with the proxy's reasons", async () => {
    const result = await run(["community/ranking/imtec.ba.json"], async () => ({
      ...VERIFIED,
      verified: false,
      reasons: ["telemetry_inactive_7d"],
    }));
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("telemetry_inactive_7d");
  });

  test("a proxy error fails without throwing", async () => {
    const result = await run(["community/ranking/imtec.ba.json"], async () => {
      throw new Error("the proxy answered 503");
    });
    expect(result.problems[0]).toContain("503");
  });

  test("a claim shared with another entry fails before verify", async () => {
    let called = false;
    const result = await run(["community/ranking/acme.com.json"], async () => {
      called = true;
      return VERIFIED;
    }, ["imtec.ba.json", "acme.com.json"]);
    expect(called).toBe(false);
    expect(result.problems[0]).toContain("imtec.ba.json");
  });

  test("a removal needs no proof, and README edits are ignored", async () => {
    const result = await checkRankingEntries({
      changes: [
        { status: "D", path: "community/ranking/imtec.ba.json" },
        { status: "M", path: "community/ranking/README.md" },
      ],
      readEntry: () => "",
      allEntries: [],
      verify: async () => {
        throw new Error("must not be called");
      },
    });
    expect(result.problems).toEqual([]);
    expect(result.summary).toEqual(["- Removed `imtec.ba.json`."]);
  });

  test("the claim differs per entry in a valid two-entry PR", async () => {
    files["community/ranking/acme.com.json"] = file("acme.com", OTHER_CLAIM);
    const result = await run(
      ["community/ranking/acme.com.json", "community/ranking/imtec.ba.json"],
      async () => VERIFIED,
      ["imtec.ba.json", "acme.com.json"],
    );
    expect(result.problems).toEqual([]);
  });
});
