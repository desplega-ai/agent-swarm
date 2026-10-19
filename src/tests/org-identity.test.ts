import { describe, expect, test } from "bun:test";
import { orgIdentityStatus } from "../utils/org-identity";

describe("orgIdentityStatus", () => {
  test.each([
    ["empty", {}, ["SWARM_ORG_NAME", "SWARM_ORG_WEBSITE"]],
    [
      "whitespace",
      { SWARM_ORG_NAME: "   ", SWARM_ORG_WEBSITE: "  " },
      ["SWARM_ORG_NAME", "SWARM_ORG_WEBSITE"],
    ],
    [
      "the catalog default",
      { SWARM_ORG_NAME: "Swarm", SWARM_ORG_WEBSITE: "acme.com" },
      ["SWARM_ORG_NAME"],
    ],
    [
      "the Slack fallback",
      { SWARM_ORG_NAME: " your swarm ", SWARM_ORG_WEBSITE: "acme.com" },
      ["SWARM_ORG_NAME"],
    ],
    [
      "an invalid website",
      { SWARM_ORG_NAME: "Acme", SWARM_ORG_WEBSITE: "localhost" },
      ["SWARM_ORG_WEBSITE"],
    ],
    ["both set", { SWARM_ORG_NAME: " Acme ", SWARM_ORG_WEBSITE: "https://www.Acme.com/" }, []],
  ] as const)("%s", (_label, src, missing) => {
    const status = orgIdentityStatus(src);
    expect(status.missing).toEqual([...missing]);
    expect(status.ok).toBe(missing.length === 0);
  });

  test("returns the trimmed name and the normalized website", () => {
    expect(
      orgIdentityStatus({ SWARM_ORG_NAME: " Acme ", SWARM_ORG_WEBSITE: "https://www.Acme.com/" }),
    ).toEqual({
      name: "Acme",
      website: "acme.com",
      missing: [],
      ok: true,
    });
  });
});
