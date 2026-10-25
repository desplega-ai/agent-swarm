import { describe, expect, mock, test } from "bun:test";

// The root tsconfig maps `@/` to the API's `src/`: point the UI aliases this
// module imports at the real UI files.
for (const [alias, path] of [
  ["@/lib/utils", "../../lib/utils"],
  ["@/hooks/use-autosave", "../../hooks/use-autosave"],
  ["@/components/ui/button", "../ui/button"],
  ["@/components/ui/input", "../ui/input"],
  ["@/components/ui/textarea", "../ui/textarea"],
  ["@/components/ui/tooltip", "../ui/tooltip"],
  ["@/components/shared/status-icon", "../shared/status-icon"],
  ["@/components/shared/secret-input", "../shared/secret-input"],
  ["@/components/onboarding/save-indicator", "./save-indicator"],
] as const) {
  mock.module(alias, () => require(path));
}

const { checkSecret, KEY_RULES } = await import("./autosave-secret-field");

// Obviously fake keys of the right shape.
const token = (fill: string) => `sk-ant-oat01-${fill.repeat(100)}`;

describe("checkSecret", () => {
  test("a space or a line break inside a key fails at once", () => {
    const key = token("a");
    for (const bad of [`${key.slice(0, 40)} ${key.slice(40)}`, `${key.slice(0, 40)}\n${key}`]) {
      expect(checkSecret(bad, KEY_RULES.claudeToken)).toEqual({
        valid: false,
        problem: "Remove the space or line break from the key.",
        problemNow: true,
      });
    }
    // Spaces around the key are trimmed.
    expect(checkSecret(`  ${key}\n`, KEY_RULES.claudeToken).valid).toBe(true);
  });

  test("an unknown format and a gateway key reject inner spaces too", () => {
    expect(checkSecret("abcd efgh ijkl mnop qrst").problem).toBe(
      "Remove the space or line break from the key.",
    );
  });

  test("a multi-line pattern (PEM) keeps its line breaks", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----"; // gitleaks:allow (fake PEM shape)
    const rule = {
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/,
    };
    expect(checkSecret(pem, rule).valid).toBe(true);
  });

  test("a pool checks every key, and names the one that fails", () => {
    const rule = KEY_RULES.claudeToken;
    expect(checkSecret(`${token("a")}, ${token("b")}`, rule, true).valid).toBe(true);
    // Without `pool`, the same value is one key with a space inside.
    expect(checkSecret(`${token("a")}, ${token("b")}`, rule).valid).toBe(false);
    expect(checkSecret(`${token("a")},sk-ant-oat01-short`, rule, true)).toEqual({
      valid: false,
      problem: "Key 2: Looks too short.",
      problemNow: false,
    });
    expect(checkSecret(`${token("a")},sk-ant-api03-${"c".repeat(100)}`, rule, true)).toEqual({
      valid: false,
      problem: "Key 2: Starts with sk-ant-oat01-",
      problemNow: true,
    });
    expect(checkSecret(`${token("a")},${token("b").replace("bbb", "b b")}`, rule, true)).toEqual({
      valid: false,
      problem: "Key 2: Remove the space or line break from the key.",
      problemNow: true,
    });
  });

  test("a pool lets the last key be typed, but not a key before a comma", () => {
    const rule = KEY_RULES.claudeToken;
    // "sk-" is the start of the prefix: still typing.
    expect(checkSecret(`${token("a")},sk-`, rule, true)).toEqual({
      valid: false,
      problem: null,
      problemNow: false,
    });
    expect(checkSecret(`sk-,${token("a")}`, rule, true)).toEqual({
      valid: false,
      problem: "Key 1: Starts with sk-ant-oat01-",
      problemNow: true,
    });
    // A trailing comma is not a key.
    expect(checkSecret(`${token("a")},`, rule, true).valid).toBe(true);
  });
});
