import { describe, expect, test } from "bun:test";
import { lintGlobalScriptPromotion } from "../be/scripts/promotion-policy";

const candidate = (body: string) => `
  export default async () => {
    const raw_events = [{ actor_anonymous_id: "install-1" }];
    ${body}
    return raw_events;
  };
`;

describe("global script promotion policy", () => {
  test("ignores scripts outside the install-population domain", () => {
    expect(
      lintGlobalScriptPromotion({
        name: "unrelated-script",
        source: "export default async () => ({ ok: true });",
      }),
    ).toEqual({ ok: true, findings: [] });
  });

  test.each([
    ["no-local-install-population-gate", 'const query = "HAVING count() >= 5";'],
    [
      "weekly-event-cut-must-be-helper-scoped-or-explicit",
      'const query = "uniqExactIf(actor_anonymous_id, c >= 5)";',
    ],
    ["install-output-name-must-state-gate", "installs: 1,"],
    ["legit-install-consumer-must-call-helper", "const legitPopulation = raw_events.length;"],
  ])("rejects %s violations", (rule, body) => {
    const result = lintGlobalScriptPromotion({
      name: "policy-candidate",
      source: candidate(body),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.findings.map((finding) => finding.rule)).toContain(rule);
  });

  test("allows an explicitly marked deliberate alternate gate", () => {
    expect(
      lintGlobalScriptPromotion({
        name: "deliberate-alternate",
        source: candidate(`
          // Integrity rule 5
          const installs_active_days = "HAVING count() >= 5";
        `),
      }),
    ).toEqual({ ok: true, findings: [] });
  });

  test.each([
    "install-population-gate-lint",
    "legit-install-population",
    "install-telemetry-profile",
  ])("allows exempt policy script %s", (name) => {
    expect(
      lintGlobalScriptPromotion({
        name,
        source: candidate('const query = "HAVING count() >= 5";'),
      }),
    ).toEqual({ ok: true, findings: [] });
  });
});
