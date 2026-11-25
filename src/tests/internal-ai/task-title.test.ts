import { describe, expect, test } from "bun:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { completeStructuredWithModel } from "../../utils/internal-ai/complete-structured.js";
import type {
  CredentialKind,
  ResolvedCredential,
  resolveCredentials,
} from "../../utils/internal-ai/credentials.js";
import {
  DEFAULT_MODEL,
  MEMORY_RATER_DEFAULT_MODEL,
  parseModelStr,
} from "../../utils/internal-ai/models.js";
import {
  buildTaskTitlePlan,
  generateTaskTitle,
  kindForModelString,
  normalizeTaskTitle,
  prepareTaskTextForTitle,
  TASK_TITLE_MAX_CHARS,
  TASK_TITLE_MAX_TASK_CHARS,
  TASK_TITLE_MODEL_CANDIDATES,
  TASK_TITLE_MODEL_ENV,
} from "../../utils/internal-ai/task-title.js";

const LONG_TASK =
  "Investigate why the nightly Playwright suite times out on the sessions page after the sidebar redesign and fix the flake.";

function credential(kind: CredentialKind): ResolvedCredential {
  return kind === "claude-cli"
    ? { kind, modelDefault: "haiku" }
    : { kind, apiKey: `key-${kind}`, modelDefault: `${kind}/default` };
}

/** `resolveCredentials` stub that offers exactly `kinds` and records every lookup. */
function resolver(kinds: CredentialKind[], calls: CredentialKind[][] = []) {
  const resolve: typeof resolveCredentials = async (opts) => {
    const wanted = [...(opts?.kinds ?? [])];
    calls.push(wanted);
    return wanted.filter((kind) => kinds.includes(kind)).map(credential);
  };
  return { resolve, calls };
}

type CompleteFn = typeof completeStructuredWithModel;

/** `completeStructuredWithModel` stub keyed by model string; absent = failure (null). */
function completer(answers: Record<string, string | Error>, models: string[] = []) {
  const complete: CompleteFn = async (opts) => {
    const model = opts._credentialOverride?.modelDefault ?? "<none>";
    models.push(model);
    const answer = answers[model];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return null;
    return { data: { title: answer }, model };
  };
  return { complete, models };
}

describe("normalizeTaskTitle", () => {
  test("collapses whitespace, strips quotes, prefix, markdown and trailing punctuation", () => {
    expect(normalizeTaskTitle('  "Fix   sessions sidebar flake."  ')).toBe(
      "Fix sessions sidebar flake",
    );
    expect(normalizeTaskTitle("Title: **Rotate Slack token**")).toBe("Rotate Slack token");
    expect(normalizeTaskTitle("“Add retry to poller”…")).toBe("Add retry to poller");
    expect(normalizeTaskTitle("`Bump bun to 1.4`")).toBe("Bump bun to 1.4");
  });

  test("keeps question marks and inner punctuation", () => {
    expect(normalizeTaskTitle("Why does the poller stall?")).toBe("Why does the poller stall?");
    expect(normalizeTaskTitle("Migrate agent-fs 0.16.3 pins")).toBe("Migrate agent-fs 0.16.3 pins");
  });

  test("cuts long titles at a word boundary under the limit", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const title = normalizeTaskTitle(words);
    expect(title.length).toBeLessThanOrEqual(TASK_TITLE_MAX_CHARS);
    expect(title.endsWith("word")).toBe(false);
    expect(words.startsWith(title)).toBe(true);
  });

  test("returns an empty string when nothing usable remains", () => {
    expect(normalizeTaskTitle('""')).toBe("");
    expect(normalizeTaskTitle(" ... ")).toBe("");
  });
});

describe("prepareTaskTextForTitle", () => {
  test("drops the sibling-awareness block and collapses blank lines", () => {
    const task = `<sibling_tasks_in_progress>\n- other\n</sibling_tasks_in_progress>\n\n\n\nFix the login bug\n\n\n\nin the auth module`;
    expect(prepareTaskTextForTitle(task)).toBe("Fix the login bug\n\nin the auth module");
  });

  test("keeps a prompt without the block and truncates long prompts", () => {
    expect(prepareTaskTextForTitle("  hello\r\nworld ")).toBe("hello\nworld");
    const long = "x".repeat(TASK_TITLE_MAX_TASK_CHARS + 500);
    const prepared = prepareTaskTextForTitle(long);
    expect(prepared.length).toBe(TASK_TITLE_MAX_TASK_CHARS + 2);
    expect(prepared.endsWith(" …")).toBe(true);
  });
});

/** `INTERNAL_AUTO_PROVIDER_ORDER`: OpenRouter is not in it. */
const AUTO_KINDS = [
  "claude-cli",
  "anthropic",
  "openai",
  "openai-codex",
  "fireworks",
  "amazon-bedrock",
];

describe("buildTaskTitlePlan", () => {
  test("default plan follows the shared internal order and leaves OpenRouter out", () => {
    const plan = buildTaskTitlePlan({});
    expect(plan.map((group) => group.kind)).toEqual(AUTO_KINDS);
    for (const group of plan) {
      expect(group.models).toEqual(
        TASK_TITLE_MODEL_CANDIDATES.find((candidate) => candidate.kind === group.kind)?.models,
      );
    }
  });

  test("INTERNAL_LLM_PROVIDER=openrouter is the opt-in, and allows only that kind", () => {
    const plan = buildTaskTitlePlan({ INTERNAL_LLM_PROVIDER: "openrouter" });
    expect(plan).toEqual([TASK_TITLE_MODEL_CANDIDATES[0]]);
    expect(plan[0]?.kind).toBe("openrouter");
  });

  test("the codex harness moves its own kinds first", () => {
    expect(buildTaskTitlePlan({ HARNESS_PROVIDER: "codex" }).map((group) => group.kind)).toEqual([
      "openai-codex",
      "openai",
      "claude-cli",
      "anthropic",
      "fireworks",
      "amazon-bedrock",
    ]);
  });

  test("a pinned model moves its provider first and the model to the front", () => {
    const plan = buildTaskTitlePlan({ [TASK_TITLE_MODEL_ENV]: "openai/gpt-5-nano" });
    expect(plan[0]).toEqual({ kind: "openai", models: ["openai/gpt-5-nano", "openai/gpt-6-luna"] });
    expect(plan.slice(1).map((group) => group.kind)).toEqual(
      AUTO_KINDS.filter((kind) => kind !== "openai"),
    );
  });

  test("a pinned openrouter model opts in to OpenRouter for its provider only", () => {
    const plan = buildTaskTitlePlan({
      [TASK_TITLE_MODEL_ENV]: "openrouter/deepseek/deepseek-v4.1-flash",
    });
    expect(plan.map((group) => group.kind)).toEqual(["openrouter", ...AUTO_KINDS]);
    expect(plan[0]?.models[0]).toBe("openrouter/deepseek/deepseek-v4.1-flash");
  });

  test("a pinned model outside the table is still tried first", () => {
    const plan = buildTaskTitlePlan({ [TASK_TITLE_MODEL_ENV]: "anthropic/claude-haiku-4-5" });
    expect(plan[0]?.models).toEqual(["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-5-5"]);
  });

  test("a bare alias pins the claude CLI; an unsupported provider is ignored", () => {
    expect(buildTaskTitlePlan({ [TASK_TITLE_MODEL_ENV]: "sonnet" })[0]).toEqual({
      kind: "claude-cli",
      models: ["sonnet", "haiku"],
    });
    expect(buildTaskTitlePlan({ [TASK_TITLE_MODEL_ENV]: "google/gemini-2.5-flash-lite" })).toEqual(
      buildTaskTitlePlan({}),
    );
  });

  test("kindForModelString maps provider prefixes", () => {
    expect(kindForModelString("openrouter/deepseek/deepseek-v4.1-flash")).toBe("openrouter");
    expect(kindForModelString("openai-codex/gpt-6-luna")).toBe("openai-codex");
    expect(kindForModelString("haiku")).toBe("claude-cli");
    expect(kindForModelString("mistral/ministral-3b")).toBeNull();
  });

  test("kindForModelString recognises the two new providers", () => {
    expect(kindForModelString("fireworks/accounts/fireworks/models/deepseek-v4p1-flash")).toBe(
      "fireworks",
    );
    expect(kindForModelString("amazon-bedrock/global.anthropic.claude-haiku-5-5")).toBe(
      "amazon-bedrock",
    );
    // No regression on the compound-id and bare-alias shapes.
    expect(kindForModelString("openrouter/anthropic/claude-haiku-5.5")).toBe("openrouter");
    expect(kindForModelString("sonnet")).toBe("claude-cli");
  });

  test("pinning either new provider moves it first with its own fallbacks", () => {
    const fireworks = buildTaskTitlePlan({
      [TASK_TITLE_MODEL_ENV]: "fireworks/accounts/fireworks/routers/kimi-k3-fast",
    });
    expect(fireworks[0]).toEqual({
      kind: "fireworks",
      models: [
        "fireworks/accounts/fireworks/routers/kimi-k3-fast",
        "fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
        "fireworks/accounts/fireworks/models/glm-5p3-flash",
      ],
    });

    const bedrock = buildTaskTitlePlan({
      [TASK_TITLE_MODEL_ENV]: "amazon-bedrock/eu.anthropic.claude-haiku-5-5",
    });
    expect(bedrock[0].kind).toBe("amazon-bedrock");
    expect(bedrock[0].models[0]).toBe("amazon-bedrock/eu.anthropic.claude-haiku-5-5");
    // A region-scoped pin does not displace the shipped defaults behind it.
    expect(bedrock[0].models).toContain("amazon-bedrock/global.anthropic.claude-haiku-5-5");
    expect(bedrock.map((group) => group.kind)).toEqual([
      "amazon-bedrock",
      ...AUTO_KINDS.filter((kind) => kind !== "amazon-bedrock"),
    ]);
  });
});

describe("generateTaskTitle", () => {
  test("short prompts are skipped before any credential lookup", async () => {
    const { resolve, calls } = resolver(["openrouter"]);
    const { complete, models } = completer({});
    const result = await generateTaskTitle({
      task: "fix the login bug",
      env: {},
      _resolveCredentials: resolve,
      _completeStructured: complete,
    });
    expect(result).toEqual({ ok: false, reason: "short-task" });
    expect(calls).toEqual([]);
    expect(models).toEqual([]);
  });

  test("uses the first provider with a credential and its cheapest model", async () => {
    const { resolve } = resolver(["anthropic", "openai"]);
    const { complete, models } = completer({
      "anthropic/claude-haiku-5-5": "Fix nightly Playwright timeout on sessions page",
    });
    const result = await generateTaskTitle({
      task: LONG_TASK,
      env: {},
      _resolveCredentials: resolve,
      _completeStructured: complete,
    });
    expect(result).toEqual({
      ok: true,
      title: "Fix nightly Playwright timeout on sessions page",
      model: "anthropic/claude-haiku-5-5",
      kind: "anthropic",
    });
    expect(models).toEqual(["anthropic/claude-haiku-5-5"]);
  });

  test("falls through models, then providers, on null results and thrown errors", async () => {
    const { resolve } = resolver(["openrouter", "openai"]);
    const { complete, models } = completer({
      "openrouter/deepseek/deepseek-v4.1-flash": new Error("429 rate limited"),
      // claude-haiku-5.5 absent → null
      "openrouter/openai/gpt-6-luna": "   ",
      "openai/gpt-6-luna": "Sessions page Playwright flake",
    });
    const result = await generateTaskTitle({
      task: LONG_TASK,
      // Pinning the first OpenRouter model opts in to OpenRouter ahead of the auto order.
      env: { [TASK_TITLE_MODEL_ENV]: "openrouter/deepseek/deepseek-v4.1-flash" },
      _resolveCredentials: resolve,
      _completeStructured: complete,
    });
    expect(result).toEqual({
      ok: true,
      title: "Sessions page Playwright flake",
      model: "openai/gpt-6-luna",
      kind: "openai",
    });
    expect(models).toEqual([
      "openrouter/deepseek/deepseek-v4.1-flash",
      "openrouter/anthropic/claude-haiku-5.5",
      "openrouter/openai/gpt-6-luna",
      "openai/gpt-6-luna",
    ]);
  });

  test("resolves one credential kind at a time and stops before the codex probe when an earlier provider answers", async () => {
    const { resolve, calls } = resolver(["anthropic", "openai-codex"]);
    const { complete } = completer({ "anthropic/claude-haiku-5-5": "A title" });
    await generateTaskTitle({
      task: LONG_TASK,
      env: {},
      apiUrl: "http://127.0.0.1:1",
      apiKey: "k",
      _resolveCredentials: resolve,
      _completeStructured: complete,
    });
    expect(calls).toEqual([["claude-cli"], ["anthropic"]]);
  });

  test("reports no-credentials when nothing resolves and all-models-failed otherwise", async () => {
    const none = resolver([]);
    const silent = completer({});
    expect(
      await generateTaskTitle({
        task: LONG_TASK,
        env: {},
        _resolveCredentials: none.resolve,
        _completeStructured: silent.complete,
      }),
    ).toEqual({ ok: false, reason: "no-credentials" });
    // Every auto kind was asked exactly once, in order; OpenRouter never.
    expect(none.calls.map((call) => call[0])).toEqual(AUTO_KINDS);

    const some = resolver(["claude-cli"]);
    expect(
      await generateTaskTitle({
        task: LONG_TASK,
        env: {},
        _resolveCredentials: some.resolve,
        _completeStructured: silent.complete,
      }),
    ).toEqual({ ok: false, reason: "all-models-failed" });
    expect(silent.models).toEqual(["haiku"]);
  });

  test("the pinned model runs first and the credential override carries it", async () => {
    const { resolve } = resolver(["openrouter", "openai"]);
    let seenOverride: ResolvedCredential | undefined;
    const complete: CompleteFn = async (opts) => {
      seenOverride = opts._credentialOverride;
      return { data: { title: "Pinned" }, model: "openai/gpt-5-nano" };
    };
    const result = await generateTaskTitle({
      task: LONG_TASK,
      env: { [TASK_TITLE_MODEL_ENV]: "openai/gpt-5-nano" },
      _resolveCredentials: resolve,
      _completeStructured: complete,
    });
    expect(result).toEqual({
      ok: true,
      title: "Pinned",
      model: "openai/gpt-5-nano",
      kind: "openai",
    });
    expect(seenOverride).toEqual({
      kind: "openai",
      apiKey: "key-openai",
      modelDefault: "openai/gpt-5-nano",
    });
  });

  test("OPENROUTER_API_KEY + CLAUDE_CODE_OAUTH_TOKEN titles through the claude CLI (#3667)", async () => {
    const { resolve, calls } = resolver(["openrouter", "claude-cli"]);
    const { complete, models } = completer({ haiku: "Sessions page Playwright flake" });
    const result = await generateTaskTitle({
      task: LONG_TASK,
      env: { OPENROUTER_API_KEY: "or", CLAUDE_CODE_OAUTH_TOKEN: "oat" },
      _resolveCredentials: resolve,
      _completeStructured: complete,
    });
    expect(result).toEqual({
      ok: true,
      title: "Sessions page Playwright flake",
      model: "haiku",
      kind: "claude-cli",
    });
    expect(models).toEqual(["haiku"]);
    expect(calls.flat()).not.toContain("openrouter");
  });

  test("INTERNAL_LLM_PROVIDER=openrouter titles through OpenRouter even with a claude token", async () => {
    const { resolve, calls } = resolver(["openrouter", "claude-cli"]);
    const { complete } = completer({ "openrouter/deepseek/deepseek-v4.1-flash": "A title" });
    const result = await generateTaskTitle({
      task: LONG_TASK,
      env: {
        OPENROUTER_API_KEY: "or",
        CLAUDE_CODE_OAUTH_TOKEN: "oat",
        INTERNAL_LLM_PROVIDER: "openrouter",
      },
      _resolveCredentials: resolve,
      _completeStructured: complete,
    });
    expect(result).toMatchObject({ ok: true, kind: "openrouter" });
    expect(calls).toEqual([["openrouter"]]);
  });

  test("an aborted signal stops the walk", async () => {
    const { resolve } = resolver(["openrouter"]);
    const { complete, models } = completer({ "openrouter/deepseek/deepseek-v4.1-flash": "T" });
    const controller = new AbortController();
    controller.abort();
    const result = await generateTaskTitle({
      task: LONG_TASK,
      env: {},
      signal: controller.signal,
      _resolveCredentials: resolve,
      _completeStructured: complete,
    });
    expect(result).toEqual({ ok: false, reason: "no-credentials" });
    expect(models).toEqual([]);
  });
});

describe("catalog verification for the new kinds", () => {
  // Every default the registries name must resolve in pi-ai's own catalog: a
  // miss is a silent null from `completeStructured`, which would leave titling
  // and summarization dead in exactly the deployments this change is for.
  test("DEFAULT_MODEL and MEMORY_RATER_DEFAULT_MODEL all exist in pi-ai's catalog", () => {
    for (const registry of [DEFAULT_MODEL, MEMORY_RATER_DEFAULT_MODEL]) {
      for (const [kind, modelStr] of Object.entries(registry)) {
        if (kind === "claude-cli") continue; // a `claude -p` alias, not a pi-ai model
        const [provider, modelId] = parseModelStr(modelStr);
        expect(provider).toBe(kind);
        expect(getBuiltinModel(provider as never, modelId as never)).toBeTruthy();
      }
    }
  });

  test("every titling candidate resolves in pi-ai's catalog", () => {
    for (const group of TASK_TITLE_MODEL_CANDIDATES) {
      if (group.kind === "claude-cli") continue;
      for (const modelStr of group.models) {
        const [provider, modelId] = parseModelStr(modelStr);
        expect(provider).toBe(group.kind);
        expect(getBuiltinModel(provider as never, modelId as never)).toBeTruthy();
      }
    }
  });
});
