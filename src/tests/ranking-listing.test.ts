import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isInternalConfigKey, validateConfigValue } from "../be/swarm-config-guard";
import {
  buildListing,
  mintRankingClaim,
  parseTelemetryRanking,
  rankingEntryFile,
} from "../ranking/telemetry-ranking";
import { RANKING_TAXONOMY } from "../telemetry-contract/ranking-taxonomy.gen";
import { orgIdentityStatus } from "../utils/org-identity";

const FIXTURES = join(import.meta.dir, "..", "telemetry-contract", "ranking", "fixtures");
const read = (kind: string, file: string) => readFileSync(join(FIXTURES, kind, file), "utf8");

describe("telemetry_ranking contract fixtures", () => {
  const expected = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as {
    invalid: Record<string, string>;
  };

  test("the fixture set is complete", () => {
    expect(readdirSync(join(FIXTURES, "valid")).length).toBeGreaterThan(0);
    expect(readdirSync(join(FIXTURES, "invalid")).sort()).toEqual(
      Object.keys(expected.invalid).sort(),
    );
  });

  for (const file of readdirSync(join(FIXTURES, "valid"))) {
    test(`valid/${file} parses`, () => {
      expect(() => parseTelemetryRanking(read("valid", file))).not.toThrow();
    });
  }

  for (const file of readdirSync(join(FIXTURES, "invalid"))) {
    test(`invalid/${file} is rejected (${expected.invalid[file]})`, () => {
      expect(() => parseTelemetryRanking(read("invalid", file))).toThrow();
    });
  }
});

describe("buildListing", () => {
  const identity = orgIdentityStatus({ SWARM_ORG_NAME: "Acme", SWARM_ORG_WEBSITE: "acme.dev" });
  const claim = mintRankingClaim();

  test("copies the name and domain from the org identity and blanks to null", () => {
    const listing = buildListing(
      identity,
      {
        category: "engineering",
        subcategory: "qa-testing",
        description: "  ",
        sourceCodeUrl: null,
      },
      claim,
      new Date("2026-10-18T10:00:00Z"),
    );
    expect(listing).toEqual({
      v: 1,
      claim,
      name: "Acme",
      domain: "acme.dev",
      category: "engineering",
      subcategory: "qa-testing",
      description: null,
      sourceCodeUrl: null,
      updatedAt: "2026-10-18T10:00:00.000Z",
    });
    expect(JSON.parse(rankingEntryFile(listing))).toEqual({
      $schema: "./schema.json",
      domain: "acme.dev",
      claim,
    });
  });

  test("refuses a missing identity and an http source URL", () => {
    expect(() =>
      buildListing(
        orgIdentityStatus({ SWARM_ORG_NAME: "Swarm", SWARM_ORG_WEBSITE: "acme.dev" }),
        { category: "other" },
        claim,
      ),
    ).toThrow("SWARM_ORG_NAME");
    expect(() =>
      buildListing(identity, { category: "other", sourceCodeUrl: "http://github.com/acme" }, claim),
    ).toThrow();
  });

  test("mints rk_ + 32 hex claims", () => {
    expect(mintRankingClaim()).toMatch(/^rk_[0-9a-f]{32}$/);
    expect(mintRankingClaim()).not.toBe(mintRankingClaim());
  });

  test("the taxonomy comes from the vendored contract", () => {
    expect(RANKING_TAXONOMY).toEqual(
      JSON.parse(readFileSync(join(FIXTURES, "..", "taxonomy.json"), "utf8")),
    );
  });
});

describe("config guard", () => {
  test("telemetry_ranking is internal and validated", () => {
    expect(isInternalConfigKey("telemetry_ranking")).toBe(true);
    expect(validateConfigValue("telemetry_ranking", "{}")).toContain("telemetry_ranking");
    expect(validateConfigValue("telemetry_ranking", read("valid", "full.json"))).toBeNull();
  });

  test("PUBLIC_RANKING_ENABLED is a boolean", () => {
    expect(validateConfigValue("PUBLIC_RANKING_ENABLED", "true")).toBeNull();
    expect(validateConfigValue("PUBLIC_RANKING_ENABLED", "yes please")).not.toBeNull();
  });
});
