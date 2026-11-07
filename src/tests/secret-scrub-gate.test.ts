/**
 * The boot sweep skips a text its gate clears (`mayRedact`). That is only
 * safe if the gate never clears a text `scrubSecrets` would change, so these
 * tests hold it to that over the scrubber's own corpus and a seeded fuzz built
 * from every trigger the passes know.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { rng } from "../../scripts/bench-boot-scrub-corpus";
import { GITLEAKS_RULES } from "../utils/secret-rules.generated";
import {
  createSweepScrubber,
  mayRedactForTesting,
  registerSensitiveKeyName,
  registerVolatileSecret,
  scrubSecrets,
  tokenRulesForTesting,
} from "../utils/secret-scrubber";
import { buildNegatives, buildPositives } from "./fixtures/secret-corpus";
import { randomToken } from "./synthetic-secret-helpers";

/** Texts the corpus has no positive for: one match for each structural rule it misses. */
function extraStructuralTexts(): string[] {
  const tok = (n: number) => randomToken(n);
  return [
    `aseph_${tok(24)}`,
    `${tok(76)}AZDO${tok(4)}`,
    `sk-or-v1-${tok(40)}`,
    `sk-${tok(32)}`,
    `eyJ${tok(20)}.eyJ${tok(20)}.${tok(20)}`,
    `signoz-ingestion-key=${tok(30)}`,
    `lin_oauth_${tok(30)}`,
    `aswt_${tok(30)}`,
  ].map((secret) => `the response included ${secret} in its body`);
}

let volatile: string;
let sensitiveName: string;

// The test preload clears volatile secrets and runtime key names after every test.
beforeEach(() => {
  volatile = `canary_${randomToken(30)}`;
  registerVolatileSecret(volatile, "GATE_CANARY_SECRET");
  sensitiveName = "gateCustomThing";
  registerSensitiveKeyName(sensitiveName);
});

describe("structural rule literals", () => {
  const texts = [...buildPositives().map((p) => p.text), ...extraStructuralTexts()];

  test("every structural rule has a fixture, and each of its matches holds one of its literals", () => {
    const uncovered: string[] = [];
    for (const rule of tokenRulesForTesting) {
      const lits = rule.lits.map((lit) => lit.toLowerCase());
      expect(lits.length, rule.name).toBeGreaterThan(0);
      let matches = 0;
      for (const text of texts) {
        for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
          matches++;
          const lower = m[0].toLowerCase();
          expect(
            lits.some((lit) => lower.includes(lit)),
            `${rule.name} matched without one of its literals`,
          ).toBe(true);
        }
      }
      if (matches === 0) uncovered.push(rule.name);
    }
    // A new rule needs a fixture here, so its literals are checked against a real match.
    expect(uncovered).toEqual([]);
  });
});

describe("gate over the corpus", () => {
  test("a positive is never cleared, and a negative is cleared or left alone by the scrub", () => {
    for (const p of [...buildPositives(), ...extraStructuralTexts().map((text) => ({ text }))]) {
      expect(mayRedactForTesting(p.text), p.text.slice(0, 40)).toBe(true);
    }
    for (const text of buildNegatives()) {
      expect(mayRedactForTesting(text) || scrubSecrets(text) === text, text.slice(0, 60)).toBe(
        true,
      );
    }
  });

  test("a known value, or a sensitive key registered at runtime, is not cleared", () => {
    expect(mayRedactForTesting(`log line ${volatile} more`)).toBe(true);
    expect(mayRedactForTesting(`${sensitiveName}=x`)).toBe(true);
    expect(mayRedactForTesting(`{"gateCustomThing": "x1y2z3"}`)).toBe(true);
    // Only the prefix of a value does not make it a hit.
    expect(mayRedactForTesting(`log line ${volatile.slice(0, 14)} more`)).toBe(false);
  });

  test("a plain log line is cleared", () => {
    expect(mayRedactForTesting("")).toBe(false);
    expect(mayRedactForTesting("ran 12 tests in 3.4s, all passed")).toBe(false);
    expect(mayRedactForTesting('{"usage":{"input_tokens":12,"output_tokens":3}}')).toBe(false);
  });

  test("the sweep scrubber returns the text itself when cleared and the scrub otherwise", () => {
    const scrub = createSweepScrubber();
    const plain = "nothing to hide here";
    expect(scrub(plain)).toBe(plain);
    for (const p of buildPositives()) expect(scrub(p.text)).toBe(scrubSecrets(p.text));
  });
});

describe("gate fuzz", () => {
  const keyNames = [
    "API_KEY",
    "apiKey",
    "api-key",
    "x.api.key",
    "GITHUB_TOKEN",
    "token",
    "accessToken",
    "refresh_token",
    "secret",
    "client_secret",
    "clientSecret",
    "Password",
    "DB_PASS",
    "aws_secret_access_key",
    "slack.bot.token",
    "private_key",
    "credentials",
    "DSN",
    "authorization",
    "Authorization",
    "codex_oauth_2",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "gateCustomThing",
    "GATE_CUSTOM_THING",
    // Look sensitive but are not.
    "input_tokens",
    "tokens",
    "passenger",
    "compass",
    "NEXT_PAGE_TOKEN",
    "sort_key",
    "token_",
    "pass",
  ];
  const separators = ["=", ": ", ":", " = ", '": "', '":"', '\\": \\"', "='", '="', ":\t", "=="];
  const values = [
    "true",
    "null",
    "$VAR",
    "$\u007bX}",
    "<token>",
    "[REDACTED:x]",
    "123",
    "string",
    "get_token()",
    "hunter2xyz99",
    "aB3dE5gH7jK9mN1pQ3sT5vX7",
    "",
  ];
  const contexts = [
    "Authorization: Bearer ",
    "authorization: basic ",
    "x-api-key: ",
    "curl -u admin:",
    "curl --user bob:",
    "--password ",
    "https://user:",
    "-----BEGIN RSA PRIVATE KEY-----",
    "postgres://svc:",
    "-u ",
    "git push -u origin main",
    "someone@example.com ",
    "see https://example.com/a ",
  ];
  const noise = ["İ", "ſ", "K", "é", "ı", "\n", "\\n", "\t", '"', "\\", "'", " ", "-", "_", "."];

  test("the gate never clears a text the scrub would change", () => {
    const rand = rng(20261106);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
    const keywords = [...new Set(GITLEAKS_RULES.rules.flatMap((r) => r.keywords))];
    const corpus = [
      ...buildPositives().flatMap((p) => [p.text, p.secret]),
      ...extraStructuralTexts(),
      ...buildNegatives(),
    ];
    const fragment = (): string => {
      const roll = rand();
      if (roll < 0.22) return `${pick(keyNames)}${pick(separators)}${pick(values)}`;
      if (roll < 0.34) return `${pick(contexts)}${pick(values)}`;
      if (roll < 0.5)
        return `${pick(keywords)}${pick(noise)}${randomToken(Math.floor(rand() * 40))}`;
      if (roll < 0.62) return pick(corpus);
      if (roll < 0.68) return `${volatile.slice(0, Math.floor(10 + rand() * 25))}`;
      if (roll < 0.8) return randomToken(Math.floor(rand() * 60));
      return pick(noise);
    };
    let cleared = 0;
    let changed = 0;
    const total = 25_000;
    for (let i = 0; i < total; i++) {
      let text = "";
      for (let n = 1 + Math.floor(rand() * 5); n > 0; n--) {
        text += fragment() + (rand() < 0.5 ? " " : pick(["\n", "\\n", ","]));
      }
      if (rand() < 0.3) text = JSON.stringify(text);
      if (rand() < 0.1) text = JSON.stringify({ type: "user", content: text });
      const gate = mayRedactForTesting(text);
      const scrubbed = scrubSecrets(text) !== text;
      if (!gate) cleared++;
      if (scrubbed) changed++;
      if (!gate && scrubbed) expect.unreachable(`gate cleared a text the scrub changes: ${text}`);
    }
    // Not vacuous: the fuzz reaches both outcomes in volume.
    expect(cleared).toBeGreaterThan(total * 0.05);
    expect(changed).toBeGreaterThan(total * 0.2);
  });
});

describe("gate key needles", () => {
  const value = "hunter2xyz99";
  const keys = ["codex_oauth", "codex_oauth_0", "codex_oauth_12", "CODEX_OAUTH_3", "codex.oauth.7"];
  const wrap = (key: string) => [
    `${key}=${value}`,
    `${key}: ${value}`,
    `{"${key}":"${value}"}`,
    `${key}=[REDACTED:${key}]`,
  ];

  // A registered name that is a suffix of another needle drops the longer needle from the dedupe;
  // `codex_oauth_<n>` ends in a digit, which no other needle covers.
  const registered = [
    "OAUTH",
    "AUTH",
    "x_oauth",
    "CODEX_OAUTH",
    "_",
    "-",
    "._",
    ...["gateCustomThing", "CustomThing", "Thing", "g"],
  ];
  for (const name of registered) {
    test(`registered ${JSON.stringify(name)}: the gate keeps what the scrub changes`, () => {
      registerSensitiveKeyName(name);
      const keyed = [...keys, name, `x${name}`, `${name}_2`, `a.${name}`];
      let checked = 0;
      for (const key of keyed) {
        for (const text of wrap(key)) {
          checked++;
          if (scrubSecrets(text) !== text && !mayRedactForTesting(text)) {
            expect.unreachable(`gate cleared a text the scrub changes: ${text}`);
          }
        }
      }
      // The pool-slot keys are among the changed texts, so the check is not vacuous.
      expect(scrubSecrets(`codex_oauth_12=${value}`)).not.toBe(`codex_oauth_12=${value}`);
      expect(checked).toBe(keyed.length * 4);
    });
  }
});
