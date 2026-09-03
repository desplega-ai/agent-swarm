import {
  type HarnessProvider,
  type InstallProvider,
  type OnboardState,
  PROVIDER_HARNESS,
} from "./types.ts";

type Env = Record<string, string | undefined>;

export type NonInteractiveProviderResult =
  | { ok: true; state: Pick<OnboardState, ProviderStateKey>; credentialLabel: string }
  | { ok: false; error: string };

type ProviderStateKey =
  | "provider"
  | "harness"
  | "credentialType"
  | "claudeOAuthToken"
  | "anthropicApiKey"
  | "openaiApiKey"
  | "openrouterApiKey"
  | "modelOverride"
  | "awsRegion"
  | "awsAccessKeyId"
  | "awsSecretAccessKey"
  | "awsSessionToken"
  | "awsProfile";

const ACCEPTED_CREDENTIALS =
  "Set one of: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (Claude Code); OPENAI_API_KEY (OpenAI); OPENROUTER_API_KEY (OpenRouter); or AWS_REGION plus AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_PROFILE and a Bedrock MODEL_OVERRIDE.";

function value(env: Env, key: string): string {
  return env[key]?.trim() ?? "";
}

function selectedProvider(env: Env): InstallProvider | null | "invalid" {
  const explicit = value(env, "HARNESS_PROVIDER").toLowerCase();
  if (explicit) {
    if (explicit === "claude") return "claude";
    if (explicit === "openai" || explicit === "codex") return "openai";
    if (explicit === "openrouter") return "openrouter";
    if (explicit === "bedrock") return "bedrock";
    if (explicit === "pi") {
      return value(env, "MODEL_OVERRIDE").toLowerCase().startsWith("amazon-bedrock/")
        ? "bedrock"
        : "openrouter";
    }
    return "invalid";
  }

  if (value(env, "CLAUDE_CODE_OAUTH_TOKEN") || value(env, "ANTHROPIC_API_KEY")) return "claude";
  if (value(env, "OPENAI_API_KEY")) return "openai";
  if (value(env, "OPENROUTER_API_KEY")) return "openrouter";
  if (
    value(env, "AWS_PROFILE") ||
    value(env, "AWS_ACCESS_KEY_ID") ||
    value(env, "MODEL_OVERRIDE").toLowerCase().startsWith("amazon-bedrock/")
  ) {
    return "bedrock";
  }
  return null;
}

function baseState(provider: InstallProvider): Pick<OnboardState, ProviderStateKey> {
  return {
    provider,
    harness: PROVIDER_HARNESS[provider] as HarnessProvider,
    credentialType: "oauth",
    claudeOAuthToken: "",
    anthropicApiKey: "",
    openaiApiKey: "",
    openrouterApiKey: "",
    modelOverride: "",
    awsRegion: "",
    awsAccessKeyId: "",
    awsSecretAccessKey: "",
    awsSessionToken: "",
    awsProfile: "",
  };
}

export function normalizeBedrockModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.toLowerCase().startsWith("amazon-bedrock/")
    ? trimmed
    : `amazon-bedrock/${trimmed}`;
}

/** Resolve and validate install-provider credentials without React side effects. */
export function resolveNonInteractiveProvider(env: Env): NonInteractiveProviderResult {
  const provider = selectedProvider(env);
  if (provider === "invalid") {
    return {
      ok: false,
      error: `Invalid HARNESS_PROVIDER "${value(env, "HARNESS_PROVIDER")}". Options: claude, codex/openai, pi/openrouter, bedrock.`,
    };
  }

  // Preserve the historical default. Its missing-credential error now explains every alternative.
  const resolvedProvider = provider ?? "claude";
  const state = baseState(resolvedProvider);

  if (resolvedProvider === "claude") {
    state.claudeOAuthToken = value(env, "CLAUDE_CODE_OAUTH_TOKEN");
    state.anthropicApiKey = value(env, "ANTHROPIC_API_KEY");
    if (!state.claudeOAuthToken && !state.anthropicApiKey)
      return { ok: false, error: ACCEPTED_CREDENTIALS };
    state.credentialType = state.anthropicApiKey ? "api_key" : "oauth";
    return {
      ok: true,
      state,
      credentialLabel: state.credentialType === "api_key" ? "API key" : "OAuth token",
    };
  }

  if (resolvedProvider === "openai") {
    state.openaiApiKey = value(env, "OPENAI_API_KEY");
    if (!state.openaiApiKey)
      return { ok: false, error: `OPENAI_API_KEY is required for OpenAI. ${ACCEPTED_CREDENTIALS}` };
    return { ok: true, state, credentialLabel: "API key" };
  }

  if (resolvedProvider === "openrouter") {
    state.openrouterApiKey = value(env, "OPENROUTER_API_KEY");
    state.modelOverride = value(env, "MODEL_OVERRIDE") || "openrouter/qwen/qwen3-coder-flash";
    if (!state.openrouterApiKey) {
      return {
        ok: false,
        error: `OPENROUTER_API_KEY is required for OpenRouter. ${ACCEPTED_CREDENTIALS}`,
      };
    }
    return { ok: true, state, credentialLabel: "API key" };
  }

  state.awsRegion = value(env, "AWS_REGION");
  state.awsAccessKeyId = value(env, "AWS_ACCESS_KEY_ID");
  state.awsSecretAccessKey = value(env, "AWS_SECRET_ACCESS_KEY");
  state.awsSessionToken = value(env, "AWS_SESSION_TOKEN");
  state.awsProfile = value(env, "AWS_PROFILE");
  const model = value(env, "MODEL_OVERRIDE");
  if (!state.awsRegion || !model) {
    return {
      ok: false,
      error: `AWS_REGION and a Bedrock MODEL_OVERRIDE are required for AWS Bedrock. ${ACCEPTED_CREDENTIALS}`,
    };
  }
  if (!state.awsProfile && (!state.awsAccessKeyId || !state.awsSecretAccessKey)) {
    return {
      ok: false,
      error: `AWS_PROFILE or AWS_ACCESS_KEY_ID plus AWS_SECRET_ACCESS_KEY is required for AWS Bedrock. ${ACCEPTED_CREDENTIALS}`,
    };
  }
  state.modelOverride = normalizeBedrockModel(model);
  return {
    ok: true,
    state,
    credentialLabel: state.awsProfile ? `AWS profile ${state.awsProfile}` : "AWS access key",
  };
}
