import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelProfile } from "@/api/types";

mock.module("@/api/types", () => require("../../api/types"));
mock.module("@/api/hooks/use-models-catalog", () => ({
  useModelsCatalog: () => ({ data: undefined }),
}));
mock.module("@/api/hooks/use-tasks", () => ({
  useTask: () => ({ data: undefined, isLoading: false }),
}));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/agent-runtime-models", () => require("../../lib/agent-runtime-models"));
mock.module("@/lib/cost-format", () => require("../../lib/cost-format"));
mock.module("@/lib/model-vendor", () => require("../../lib/model-vendor"));
mock.module("@/lib/model-tiers", () => require("../../lib/model-tiers"));
mock.module("@/lib/task-model-resolution", () => require("../../lib/task-model-resolution"));
mock.module("@/components/shared/effort-mark", () => require("./effort-mark"));
mock.module("@/components/shared/harness-icon", () => require("./harness-icon"));
mock.module("@/components/shared/model-logo", () => require("./model-logo"));
mock.module("@/components/shared/reasoning-effort-icon", () => require("./reasoning-effort-icon"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/hover-card", () => require("../ui/hover-card"));
mock.module("@/components/ui/skeleton", () => require("../ui/skeleton"));

const { ModelDetails, acceptedCredentials, credentialLabel } = await import("./model-details-card");

/** Visible text with tags stripped, so assertions read like the card. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const customProfile = {
  name: "fast-reviewer",
  harness: "codex",
  model: "gpt-6.1-sol",
  effort: "medium",
  seededFrom: null,
  credentials: { CODEX_OAUTH: ["OMmph-1"] },
} as unknown as ModelProfile;

describe("model details card", () => {
  test("shows the model, seeded profile, cost and the subscription that served it", () => {
    const out = text(
      renderToStaticMarkup(
        <ModelDetails
          task={{
            id: "t1",
            resolvedModel: "claude-opus-5-5",
            resolvedEffort: "high",
            resolvedProfile: "claude-smart",
            modelSource: "profile:agent-default",
            modelTier: "smart",
            provider: "claude",
            totalCostUsd: 1.2345,
            credentialKeyType: "CLAUDE_CODE_OAUTH_TOKEN",
            credentialKeySuffix: "x9Qa",
          }}
        />,
      ),
    );
    expect(out).toContain("Claude Opus 5.5");
    expect(out).toContain("Anthropic · claude-opus-5-5");
    expect(out).toContain("Profile claude-smart seeded Definition unknown");
    expect(out).toContain("Effort High");
    expect(out).toContain("Chosen by Agent default profile");
    expect(out).toContain("Tier Smart");
    expect(out).toContain("Task cost $1.23");
    expect(out).toContain("Rate / 1M $4.00 in · $20.00 out");
    expect(out).toContain("Served by Claude subscription CLAUDE_CODE_OAUTH_TOKEN …x9Qa");
    expect(out).toContain("Accepts CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY");
  });

  test("custom profiles show their definition and pinned credentials", () => {
    const out = text(
      renderToStaticMarkup(
        <ModelDetails
          task={{
            id: "t2",
            resolvedModel: "gpt-6.1-sol",
            resolvedProfile: "fast-reviewer",
            resolvedEffort: "medium",
            modelSource: "profile:task",
            totalCostUsd: 0.0412,
            credentialKeyType: "CODEX_OAUTH",
            credentialKeySuffix: "OMmph-1",
          }}
          profile={customProfile}
        />,
      ),
    );
    expect(out).toContain("Profile fast-reviewer custom codex · gpt-6.1-sol · medium");
    expect(out).toContain("Task cost $0.0412");
    expect(out).toContain("Served by ChatGPT subscription CODEX_OAUTH …OMmph-1");
    expect(out).toContain("Accepts CODEX_OAUTH, OPENAI_API_KEY");
    expect(out).toContain("Pinned to CODEX_OAUTH");
  });

  test("missing data reads Unknown, never a guess", () => {
    const out = text(
      renderToStaticMarkup(<ModelDetails task={{ id: "t3", resolvedModel: "my-local-llm" }} />),
    );
    expect(out).toContain("Unknown provider · my-local-llm");
    expect(out).toContain("Profile None");
    expect(out).toContain("Chosen by Unknown");
    expect(out).toContain("Task cost Unknown");
    expect(out).toContain("Rate / 1M Unknown");
    expect(out).toContain("Served by Unknown");
    expect(out).toContain("Accepts Unknown");
    expect(out).not.toContain("Pinned to");
  });

  test("an unclaimed tier task says the model is not resolved yet", () => {
    const out = text(
      renderToStaticMarkup(<ModelDetails task={{ id: "t4", modelTier: "regular" }} />),
    );
    expect(out).toContain("Not resolved yet");
    expect(out).toContain("Tier Regular");
  });

  test("shows a placeholder while the credential loads", () => {
    const html = renderToStaticMarkup(
      <ModelDetails task={{ id: "t5", resolvedModel: "claude-opus-5-5" }} credentialLoading />,
    );
    expect(html).toContain('aria-label="Loading credential"');
    expect(text(html)).not.toContain("Served by Unknown");
  });

  test("credential labels name subscriptions and API keys, unknown types stay raw", () => {
    expect(credentialLabel("CODEX_OAUTH")).toBe("ChatGPT subscription");
    expect(credentialLabel("OPENROUTER_API_KEY")).toBe("OpenRouter API key");
    expect(credentialLabel("NAN_API_KEY")).toBe("NAN_API_KEY");
    expect(acceptedCredentials("codex", "CODEX_OAUTH")).toEqual(["CODEX_OAUTH"]);
    expect(acceptedCredentials("pi", "OPENROUTER_API_KEY")).toEqual(["OPENROUTER_API_KEY"]);
    expect(acceptedCredentials(undefined, undefined)).toEqual([]);
  });
});
