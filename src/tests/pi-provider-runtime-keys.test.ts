// The pi harness resolves credentials for every provider pi-ai ships a catalog
// for, not only the handful it hardcodes. `FIREWORKS_API_KEY` is the case that
// surfaced the gap: readiness refused a worker whose only inference credential
// was FIREWORKS_API_KEY, and a session never received the key either. Both
// halves live here so the next provider pi-ai adds is covered by the dependency
// bump alone.
//
// Only `src/providers/` is imported: readiness and the per-session wiring are
// both the adapter's, and the black-box e2e suite never starts a pi worker with
// a real harness credential to observe either.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPiMonoCredentials,
  createPiRuntimeAuth,
  resolveModel,
} from "../providers/pi-mono-adapter";

/** A real chat model id from pi-ai's `fireworks` catalog. */
const FIREWORKS_MODEL_ID = "accounts/fireworks/models/deepseek-v4p1-flash";
const FIREWORKS_MODEL = `fireworks/${FIREWORKS_MODEL_ID}`;

/** A home dir nothing has logged into, so readiness cannot fall back to auth.json. */
function withCleanHome<T>(
  fn: (opts: { homeDir: string; fs: { existsSync(): boolean } }) => Promise<T>,
) {
  return async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "pi-provider-keys-"));
    try {
      return await fn({ homeDir, fs: { existsSync: () => false } });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  };
}

describe("checkPiMonoCredentials — pi-ai provider keys", () => {
  test(
    "ready from FIREWORKS_API_KEY alone, with no MODEL_OVERRIDE",
    withCleanHome(async (opts) => {
      const status = await checkPiMonoCredentials({ FIREWORKS_API_KEY: "x" }, opts);
      expect(status.ready).toBe(true);
      expect(status.satisfiedBy).toBe("env");
      expect(status.missing).toEqual([]);
    }),
  );

  test(
    "a fireworks/* model is satisfied by FIREWORKS_API_KEY and nothing else",
    withCleanHome(async (opts) => {
      const env = { MODEL_OVERRIDE: FIREWORKS_MODEL };
      const missing = await checkPiMonoCredentials(env, opts);
      expect(missing.ready).toBe(false);
      expect(missing.missing).toEqual(["FIREWORKS_API_KEY", `${opts.homeDir}/.pi/agent/auth.json`]);
      expect(missing.hint).toContain("FIREWORKS_API_KEY");

      const ready = await checkPiMonoCredentials({ ...env, FIREWORKS_API_KEY: "x" }, opts);
      expect(ready.ready).toBe(true);
      expect(ready.satisfiedBy).toBe("env");

      // Another provider's key does not satisfy a fireworks/* model.
      expect((await checkPiMonoCredentials({ ...env, ANTHROPIC_API_KEY: "x" }, opts)).ready).toBe(
        false,
      );
    }),
  );

  test(
    "other chat-capable pi-ai provider keys are enough; a classifier-only one is not",
    withCleanHome(async (opts) => {
      // pi resolves these itself, so a worker holding only one is runnable.
      for (const keyVar of ["DEEPSEEK_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"]) {
        expect((await checkPiMonoCredentials({ [keyVar]: "x" }, opts)).ready).toBe(true);
      }
      // TYPESAFE_API_KEY serves classifier models only: not an inference credential.
      const status = await checkPiMonoCredentials({ TYPESAFE_API_KEY: "x" }, opts);
      expect(status.ready).toBe(false);
      expect(status.missing).toContain(`${opts.homeDir}/.pi/agent/auth.json`);
    }),
  );

  test(
    "no keys at all stays not-ready with an actionable missing list",
    withCleanHome(async (opts) => {
      const status = await checkPiMonoCredentials({}, opts);
      expect(status.ready).toBe(false);
      expect(status.missing).toEqual([
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
        "OPENAI_API_KEY",
        `${opts.homeDir}/.pi/agent/auth.json`,
      ]);
      expect(status.hint).toContain("FIREWORKS_API_KEY");
    }),
  );

  test(
    "an explicit model of an unknown provider does not become permissive",
    withCleanHome(async (opts) => {
      // Unknown provider prefix: the check falls back to the permissive branch,
      // so a key for a provider it does not know still makes the worker ready
      // but a genuinely keyless worker stays not-ready.
      expect((await checkPiMonoCredentials({ MODEL_OVERRIDE: "nope/model-x" }, opts)).ready).toBe(
        false,
      );
    }),
  );
});

describe("createPiRuntimeAuth — pi-ai provider keys", () => {
  test("forwards FIREWORKS_API_KEY to pi's fireworks provider", async () => {
    const modelRuntime = await createPiRuntimeAuth({ FIREWORKS_API_KEY: "example-fireworks-key" });

    await expect(modelRuntime.getAuth("fireworks")).resolves.toMatchObject({
      auth: { apiKey: "example-fireworks-key" },
    });
    expect(modelRuntime.getProviderAuthStatus("fireworks").configured).toBe(true);
  });

  test("forwards the key without it being present in process.env", async () => {
    // A pool pick for this task lives only in the task env. pi reads
    // `process.env` for env-backed providers, so a missing runtime key would
    // make a ready worker fail its first inference call.
    const saved = process.env.FIREWORKS_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    try {
      const modelRuntime = await createPiRuntimeAuth({
        FIREWORKS_API_KEY: "example-session-only-key",
      });
      await expect(modelRuntime.getAuth("fireworks")).resolves.toMatchObject({
        auth: { apiKey: "example-session-only-key" },
      });
    } finally {
      if (saved === undefined) delete process.env.FIREWORKS_API_KEY;
      else process.env.FIREWORKS_API_KEY = saved;
    }
  });

  test("keeps the hand-written rows working for their own providers", async () => {
    const modelRuntime = await createPiRuntimeAuth({
      OPENROUTER_API_KEY: "example-openrouter-key",
      ANTHROPIC_API_KEY: "example-anthropic-key",
    });

    await expect(modelRuntime.getAuth("openrouter")).resolves.toMatchObject({
      auth: { apiKey: "example-openrouter-key" },
    });
    await expect(modelRuntime.getAuth("anthropic")).resolves.toMatchObject({
      auth: { apiKey: "example-anthropic-key" },
    });
  });
});

describe("resolveModel — pi-ai provider catalogs", () => {
  test("resolves a fireworks/* model id from the pi-ai catalog", () => {
    const model = resolveModel(FIREWORKS_MODEL);
    expect(model?.provider).toBe("fireworks");
    expect(model?.id).toBe(FIREWORKS_MODEL_ID);
  });
});
