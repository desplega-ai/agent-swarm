import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { convertGoRegex, stripKeyPrefix } from "../../scripts/gen-secret-rules";
import { GITLEAKS_RULES } from "../utils/secret-rules.generated";
import {
  clearVolatileSecretsForTesting,
  scrubSecrets,
  setGitleaksPassEnabledForTesting,
} from "../utils/secret-scrubber";
import { buildNegatives, buildPositives } from "./fixtures/secret-corpus";
import { randomToken } from "./synthetic-secret-helpers";

describe("convertGoRegex", () => {
  test("turns a leading (?i) into the i flag", () => {
    expect(convertGoRegex("(?i)abc")).toEqual({ source: "abc", flags: "i" });
  });

  test("scopes a mid-pattern (?i) to the rest of its group", () => {
    const { source, flags } = convertGoRegex(String.raw`\b(p8e-(?i)[a-z0-9]{4})x`);
    expect(source).toBe(String.raw`\b(p8e-(?i:[a-z0-9]{4}))x`);
    const re = new RegExp(source, flags);
    expect(re.test("p8e-AbCdx")).toBe(true);
    expect(re.test("P8E-abcdx")).toBe(false);
    expect(re.test("p8e-abcdX")).toBe(false);
  });

  test("keeps a mid-pattern (?i) on every later branch of its group", () => {
    const { source } = convertGoRegex("(a(?i)b|c)d");
    expect(source).toBe("(a(?i:b)|(?i:c))d");
    const re = new RegExp(`^${source}$`);
    expect(re.test("aBd")).toBe(true);
    expect(re.test("Cd")).toBe(true);
    expect(re.test("Ab")).toBe(false);
  });

  test("rewrites named groups, POSIX classes, \\z, \\A and a leading ] in a class", () => {
    expect(convertGoRegex("(?P<x>a)").source).toBe("(?<x>a)");
    expect(convertGoRegex("[[:alnum:]]{2}").source).toBe("[A-Za-z0-9]{2}");
    expect(convertGoRegex(String.raw`\Aa\z`).source).toBe("^a$");
    expect(convertGoRegex("[^]]+").source).toBe(String.raw`[^\]]+`);
  });

  test("rejects RE2-only syntax instead of converting it wrong", () => {
    expect(() => convertGoRegex(String.raw`\pL`)).toThrow(/unsupported escape/);
    expect(() => convertGoRegex("(?U)a+")).toThrow(/unsupported inline flags/);
    expect(() => convertGoRegex("[[:graph:]]")).toThrow(/POSIX class/);
  });

  test("strips the keyword-context name prefix, also inside a leading (?i:", () => {
    const prefix = String.raw`[\w.-]{0,50}?`;
    expect(stripKeyPrefix(`${prefix}(?:okta)`)).toBe("(?:okta)");
    expect(stripKeyPrefix(`${prefix}(?i:${prefix}(?:okta))`)).toBe("(?i:(?:okta))");
    expect(stripKeyPrefix("(?:okta)")).toBe("(?:okta)");
  });
});

describe("generated gitleaks rules", () => {
  test("every rule compiles under Bun and has a keyword", () => {
    expect(GITLEAKS_RULES.rules.length).toBeGreaterThan(200);
    for (const rule of GITLEAKS_RULES.rules) {
      expect(() => new RegExp(rule.source, `${rule.flags}gd`), rule.id).not.toThrow();
      expect(rule.keywords.length, rule.id).toBeGreaterThan(0);
    }
  });

  test("generic-api-key is excluded with a reason", () => {
    const excluded = GITLEAKS_RULES.excluded.find((rule) => rule.id === "generic-api-key");
    expect(excluded?.reason).toBeTruthy();
    expect(GITLEAKS_RULES.rules.some((rule) => rule.id === "generic-api-key")).toBe(false);
  });

  // ReDoS bound: the rules were written for RE2 (linear time); JS backtracks.
  // Timing-sensitive on a shared CI runner, so retry absorbs a noisy-neighbour
  // spike; a real catastrophic pattern takes seconds and fails every attempt.
  test(
    "each rule finishes a 100 KB adversarial input in under 50 ms",
    () => {
      const SIZE = 100_000;
      const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
      const slow: string[] = [];
      for (const rule of GITLEAKS_RULES.rules) {
        const re = new RegExp(rule.source, `${rule.flags}gd`);
        const kw = rule.keywords[0] as string;
        const inputs = [
          fill("a"),
          fill(kw),
          fill(`${kw} = `),
          fill(`${kw}_key = "${"a1B2".repeat(4)}`),
          fill(`${kw}${"aB3-".repeat(30)}\n`),
          fill(`${kw}.${"a".repeat(60)}.`),
          fill(`${kw}:${"9".repeat(12)}:`),
          fill(`${kw}${"=".repeat(20)} `),
        ];
        for (const input of inputs) {
          const start = performance.now();
          re.lastIndex = 0;
          for (let m = re.exec(input); m !== null; m = re.exec(input)) {
            if (m[0].length === 0) re.lastIndex++;
          }
          const ms = performance.now() - start;
          if (ms >= 50) slow.push(`${rule.id}: ${ms.toFixed(1)} ms on ${input.slice(0, 24)}…`);
        }
      }
      expect(slow).toEqual([]);
    },
    { retry: 2, timeout: 60_000 },
  );
});

describe("secret corpus", () => {
  const positives = buildPositives();

  test.each(positives.map((p) => [p.name, p] as const))("redacts %s", (_name, p) => {
    const out = scrubSecrets(p.text);
    expect(out).not.toContain(p.secret);
    expect(out).toContain("[REDACTED:");
    if (p.gitleaksRule) expect(out).toContain(`[REDACTED:gitleaks:${p.gitleaksRule}]`);
    // Context around the secret survives, and a second scrub is a no-op.
    expect(out.length).toBeGreaterThan(0);
    expect(scrubSecrets(out)).toBe(out);
  });

  test("redacts only the secret of a keyword-context rule, not its key", () => {
    const p = positives.find((x) => x.name === "mailgun");
    expect(scrubSecrets(p?.text)).toBe("mailgun: [REDACTED:gitleaks:mailgun-private-api-token]");
  });

  test("redacts two secrets that share one delimiter", () => {
    // azure-ad-client-secret consumes a delimiter on each side, so `a b`
    // shares one space between the two matches.
    const azure = () =>
      [randomBytes(3).toString("hex").slice(0, 3), "7Q", "~", randomToken(31)].join("");
    const pairs: [string, string][] = [[azure(), azure()]];
    // The same check for every bare-secret positive (no custom context).
    const again = new Map(buildPositives().map((p) => [p.name, p]));
    for (const p of positives) {
      const q = again.get(p.name);
      if (q && p.text === `the response included ${p.secret} in its body`) {
        pairs.push([p.secret, q.secret]);
      }
    }
    for (const [a, b] of pairs) {
      for (const sep of [" ", "\n", "\t"]) {
        const out = scrubSecrets(`${a}${sep}${b}`);
        expect(out, `${a.slice(0, 6)}… ${JSON.stringify(sep)}`).not.toContain(a);
        expect(out, `${b.slice(0, 6)}… ${JSON.stringify(sep)}`).not.toContain(b);
        expect(out).toMatch(new RegExp(`^\\[REDACTED:[^\\]]+\\]${sep}\\[REDACTED:[^\\]]+\\]$`));
      }
    }
  });

  test("redacts a token whose last character is a dash or equals sign", () => {
    // `\b` after a trailing `-` backtracks one character and leaves it behind.
    const tokens = [
      `ATATT3${randomToken(185)}-`,
      `ATATT3${randomToken(185)}=`,
      `glpat-${randomToken(19)}-`,
      `AIza${randomToken(34)}-`,
      `npm_${randomToken(35)}-`,
      `lin_api_${randomToken(39)}-`,
    ];
    for (const token of tokens) {
      for (const tail of ["", " next", "\n"]) {
        expect(scrubSecrets(`${token}${tail}`), token.slice(0, 6)).toMatch(
          new RegExp(`^\\[REDACTED:[^\\]]+\\]${tail}$`),
        );
      }
    }
  });

  test("leaves every negative untouched", () => {
    const changed = buildNegatives().filter((text) => scrubSecrets(text) !== text);
    expect(changed).toEqual([]);
  });

  test("a gitleaks rule below its entropy floor is not a finding", () => {
    // stripe-access-token has entropy 2; a run of one char has entropy 0.
    const lowEntropy = ["sk", "live", "a".repeat(24)].join("_");
    expect(scrubSecrets(`got ${lowEntropy} back`)).toBe(`got ${lowEntropy} back`);
  });

  test("a rule's allowlist claims a match, and only that match", () => {
    // vault-service-token allowlists legacy `s.` + 24 letters (no digits).
    const lettersOnly = `vault said s.${"AbCdEfGhIjKlMnOpQrStUvWx"} ok`;
    expect(scrubSecrets(lettersOnly)).toBe(lettersOnly);
    const withDigit = ["s", `${randomToken(23)}7`].join(".");
    expect(scrubSecrets(`vault said ${withDigit} ok`)).toBe(
      "vault said [REDACTED:gitleaks:vault-service-token] ok",
    );
  });
});

describe("pass 5 throughput", () => {
  // Informational budget. Timing-sensitive on a shared CI runner: retry
  // absorbs a spike; a real regression fails every attempt.
  test(
    "10k lines with pass 5 cost under 2x the run without it",
    () => {
      const lines: string[] = [];
      for (let i = 0; i < 10_000; i++) {
        lines.push(
          `{"type":"assistant","line":${i},"text":"ran task step ${i} in /workspace/repo with key ${randomToken(16)} and they exit 0"}`,
        );
      }
      const time = (enabled: boolean): number => {
        setGitleaksPassEnabledForTesting(enabled);
        for (const line of lines.slice(0, 500)) scrubSecrets(line);
        const runs: number[] = [];
        for (let r = 0; r < 3; r++) {
          const start = performance.now();
          for (const line of lines) scrubSecrets(line);
          runs.push(performance.now() - start);
        }
        return runs.sort((a, b) => a - b)[1] ?? 0;
      };
      try {
        clearVolatileSecretsForTesting();
        const without = time(false);
        const withPass = time(true);
        console.log(
          `[secret-rules bench] 10k lines: ${without.toFixed(1)} ms without pass 5, ${withPass.toFixed(1)} ms with it`,
        );
        expect(withPass).toBeLessThanOrEqual(without * 2);
      } finally {
        setGitleaksPassEnabledForTesting(true);
      }
    },
    { retry: 2, timeout: 60_000 },
  );
});
