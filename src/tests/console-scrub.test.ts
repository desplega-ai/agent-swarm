import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { installConsoleLogBridge, uninstallConsoleLogBridge } from "../otel-impl";
import { installConsoleScrub, uninstallConsoleScrub } from "../utils/console-scrub";

// Built at runtime so no secret-shaped literal sits in the repo.
const SECRET = `ghp_${"Q".repeat(36)}`;
const REDACTED = "[REDACTED:";

const METHODS = ["log", "info", "warn", "error", "debug"] as const;
type Method = (typeof METHODS)[number];

let saved: Record<Method, (...args: unknown[]) => void>;
let written: { method: Method; args: unknown[] }[];

// Stand-ins for the underlying stream writers; the scrub wraps these.
beforeEach(() => {
  written = [];
  saved = { ...console } as typeof saved;
  for (const method of METHODS) {
    console[method] = (...args: unknown[]) => {
      written.push({ method, args });
    };
  }
});

afterEach(() => {
  uninstallConsoleLogBridge();
  uninstallConsoleScrub();
  for (const method of METHODS) console[method] = saved[method];
});

function lastLine(): string {
  const entry = written.at(-1);
  if (!entry) throw new Error("nothing written");
  expect(entry.args).toHaveLength(1);
  return entry.args[0] as string;
}

describe("installConsoleScrub", () => {
  test("redacts strings, Error message and stack, and objects on every method", () => {
    installConsoleScrub();
    for (const method of METHODS) {
      console[method]("token is", SECRET);
      const line = lastLine();
      expect(written.at(-1)?.method).toBe(method);
      expect(line).toStartWith("token is ");
      expect(line).not.toContain(SECRET);
      expect(line).toContain(REDACTED);
    }

    const err = new Error(`auth failed with ${SECRET}`);
    console.error("boom:", err);
    const errLine = lastLine();
    expect(errLine).toContain("auth failed with");
    expect(errLine).toContain("console-scrub.test.ts"); // the stack survived
    expect(errLine).not.toContain(SECRET);
    expect(errLine).toContain(REDACTED);

    console.log({ service: "github", nested: { value: SECRET } });
    const objLine = lastLine();
    expect(objLine).toContain("github");
    expect(objLine).not.toContain(SECRET);
    expect(objLine).toContain(REDACTED);
  });

  test("keeps printf-style substitution", () => {
    installConsoleScrub();
    console.log("%s has %d items and key %s", "queue", 3, SECRET);
    const line = lastLine();
    expect(line).toStartWith("queue has 3 items and key ");
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain("%s");
  });

  test("a second install is a no-op", () => {
    installConsoleScrub();
    const wrapped = console.log;
    installConsoleScrub();
    expect(console.log).toBe(wrapped);
    uninstallConsoleScrub();
    console.log("plain", SECRET);
    expect(written.at(-1)?.args).toEqual(["plain", SECRET]);
  });

  test("an OTel bridge installed afterwards forwards only scrubbed text", () => {
    installConsoleScrub();
    installConsoleLogBridge();
    console.warn(`leaked ${SECRET}`);
    const line = lastLine();
    expect(line).not.toContain(SECRET);
    expect(line).toContain(REDACTED);
  });

  test("a log written by a custom inspector during formatting fails closed", () => {
    installConsoleScrub();
    const noisy = {
      [inspect.custom]() {
        console.log("nested", SECRET);
        return "noisy-object";
      },
    };
    console.log("outer", noisy);
    expect(written).toHaveLength(2);
    const [nested, outer] = written.map((entry) => entry.args);
    expect(nested).toEqual([
      "[console-scrub] suppressed a log line written while formatting another",
    ]);
    expect(outer).toEqual(["outer noisy-object"]);
    expect(JSON.stringify(written)).not.toContain(SECRET);
  });

  test("a formatting throw writes a fixed line, never the raw arguments", () => {
    installConsoleScrub();
    const broken = {
      [inspect.custom]() {
        throw new Error(`inspector failed near ${SECRET}`);
      },
    };
    console.error("payload", SECRET, broken);
    expect(written).toHaveLength(1);
    expect(written[0]?.args).toEqual(["[console-scrub] failed to scrub log line"]);
    expect(JSON.stringify(written)).not.toContain(SECRET);
  });

  test("zero arguments still print an empty line", () => {
    installConsoleScrub();
    console.log();
    expect(written.at(-1)?.args).toEqual([]);
  });

  test("10k lines stay cheap", () => {
    installConsoleScrub();
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) console.log(`[worker] polling task ${i}`, { attempt: i });
    const elapsedMs = performance.now() - started;
    expect(written).toHaveLength(10_000);
    // Generous bound for slow CI runners; measured about 450 ms in a worker container.
    expect(elapsedMs).toBeLessThan(3_000);
  });
});
