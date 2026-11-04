import type { ApiKeyStatus, CodexAccount, PoolKey, UsageSummaryByCredentialRow } from "@/api/types";
import type { ProviderIconKey } from "./agent-runtime-models";

/*
 * The LLM providers that Connect › AI providers can add, in Add menu order.
 * One entry per provider: its credential pool var (the API's
 * `CREDENTIAL_POOL_VARS`, mirrored here because the dashboard never imports
 * `src/`), the harnesses that read it, the setup steps and the fields. The
 * steps reuse the copy of the `/setup` AI cards. `ai-providers.test.ts`
 * fails when the API adds a pool var that no entry claims.
 */

export type AiProviderGroup = "subscription" | "api-key" | "gateway";

export const AI_PROVIDER_GROUPS: { id: AiProviderGroup; label: string }[] = [
  { id: "subscription", label: "Subscriptions" },
  { id: "api-key", label: "API keys" },
  { id: "gateway", label: "Gateways and OpenAI-compatible" },
];

/** A provider mark: a `ProviderIcon` glyph, a mono logo file, a lucide icon, or a letter. */
export type AiProviderLogo =
  | { provider: ProviderIconKey }
  | { src: string }
  | { lucide: "route" | "cloud" }
  | { letter: string };

/**
 * One setup step. `text` takes `code` in backticks and `[label](https://...)`
 * links. `command` renders under the text with a copy button.
 */
export interface AiProviderStep {
  text: string;
  command?: string;
}

export interface AiProviderField {
  /** The `swarm_config` key. */
  key: string;
  label: string;
  /**
   * `pool`: a credential pool, added one key at a time through
   * `/api/config/pool-keys` (the API checks it first). `secret` and `text`:
   * a plain global config value, saved with the panel's Save.
   */
  kind: "pool" | "secret" | "text";
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

export interface AiProvider {
  id: string;
  name: string;
  group: AiProviderGroup;
  /** The type tag in the list. */
  type: "Subscription" | "OAuth" | "API key" | "Gateway" | "System One";
  logo: AiProviderLogo;
  /** Harnesses that use the credential, as people name them. */
  harnesses: string[];
  /** One credential, as the panel names it ("token", "key", "account"). */
  noun: string;
  /** Who checks the credential ("Anthropic"), for the live-check line. */
  vendor: string;
  /** The pool var the list groups by. `CODEX_OAUTH` is the ChatGPT accounts. */
  poolVar?: string;
  /** Config keys that mean "set up" for a provider without its own pool. */
  configuredBy?: string[];
  /** The API checks a new key with the provider before it saves it. */
  liveCheck: boolean;
  summary: string;
  steps: AiProviderStep[];
  /** A note under the steps (terms, key aliases). */
  note?: string;
  docs: { label: string; href: string };
  fields: AiProviderField[];
  /** The integration page with every setting, for providers with more than the panel shows. */
  settingsPath?: string;
  /** The panel footer line, in place of the live-check line. */
  footer?: string;
}

const DOCS = "https://docs.agent-swarm.dev/docs/guides";
const HARNESS_GUIDE = { label: "Harness guide", href: `${DOCS}/harness-configuration` };
const GATEWAY_GUIDE = {
  label: "Harness guide",
  href: `${DOCS}/harness-configuration#nan-and-helmcode`,
};

const CLAUDE_TOKEN_TERMS =
  "The swarm runs the unmodified Claude Code CLI. Anthropic documents setup tokens for CI and automation on your own subscription. Do not share a token across people or organizations.";

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: "claude",
    name: "Claude subscription",
    group: "subscription",
    type: "Subscription",
    logo: { provider: "anthropic" },
    harnesses: ["Claude Code"],
    noun: "token",
    vendor: "Anthropic",
    poolVar: "CLAUDE_CODE_OAUTH_TOKEN",
    liveCheck: true,
    summary:
      "Claude Code agents bill your Claude plan instead of paying per token. Agents rotate across the tokens.",
    steps: [
      { text: "On a computer with Claude Code, run this command.", command: "claude setup-token" },
      { text: "Copy the token that it prints. It starts with `sk-ant-oat01-`." },
      { text: "Paste it below. Add one token for each Claude account." },
    ],
    note: CLAUDE_TOKEN_TERMS,
    docs: HARNESS_GUIDE,
    fields: [
      {
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        label: "Subscription token",
        kind: "pool",
        placeholder: "sk-ant-oat01-...",
        help: "A token wins over an Anthropic API key when both are set.",
      },
    ],
  },
  {
    id: "codex",
    name: "Codex (ChatGPT)",
    group: "subscription",
    type: "OAuth",
    logo: { provider: "openai" },
    // `CODEX_OAUTH` serves the codex adapter and pi's `openai-codex/` models.
    // opencode has no ChatGPT sign-in (`src/providers/opencode-adapter.ts`).
    harnesses: ["Codex", "pi"],
    noun: "account",
    vendor: "OpenAI",
    poolVar: "CODEX_OAUTH",
    liveCheck: false,
    summary:
      "One ChatGPT subscription serves the codex and pi harnesses. Agents rotate across the signed-in accounts.",
    steps: [
      {
        text: "In ChatGPT, open Settings, Security and turn on “Allow device code login”. Workspace admins control it for team workspaces.",
      },
      { text: "Click Sign in with ChatGPT, then enter the code on the ChatGPT page." },
      { text: "Do it again for each account. Each sign-in adds one account to the pool." },
    ],
    docs: { label: "Codex OAuth guide", href: `${DOCS}/provider-auth/codex-oauth` },
    fields: [],
  },
  {
    id: "anthropic",
    name: "Anthropic API key",
    group: "api-key",
    type: "API key",
    logo: { provider: "anthropic" },
    harnesses: ["Claude Code", "pi", "opencode"],
    noun: "key",
    vendor: "Anthropic",
    poolVar: "ANTHROPIC_API_KEY",
    liveCheck: true,
    summary:
      "Billed per token. Claude Code uses it when no subscription token is set. Agents rotate across the keys.",
    steps: [
      { text: "Create a key at [console.anthropic.com](https://console.anthropic.com)." },
      { text: "Paste it below. It starts with `sk-ant-api03-`." },
    ],
    docs: HARNESS_GUIDE,
    fields: [
      { key: "ANTHROPIC_API_KEY", label: "API key", kind: "pool", placeholder: "sk-ant-api03-..." },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    group: "api-key",
    type: "API key",
    logo: { provider: "openai" },
    harnesses: ["Codex", "pi", "opencode", "fx"],
    noun: "key",
    vendor: "OpenAI",
    poolVar: "OPENAI_API_KEY",
    liveCheck: true,
    summary: "Codex uses it when no ChatGPT sign-in is stored. Agents rotate across the keys.",
    steps: [
      {
        text: "Create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).",
      },
      { text: "Paste it below. It starts with `sk-`." },
    ],
    docs: HARNESS_GUIDE,
    fields: [{ key: "OPENAI_API_KEY", label: "API key", kind: "pool", placeholder: "sk-..." }],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    group: "api-key",
    type: "API key",
    logo: { src: "/provider-logos/deepseek.svg" },
    harnesses: ["dsh"],
    noun: "key",
    vendor: "DeepSeek",
    poolVar: "DEEPSEEK_API_KEY",
    liveCheck: true,
    summary:
      "DeepSeek models for the dsh harness. dsh can also reach them through OpenRouter: the model prefix picks the route.",
    steps: [
      {
        text: "Create a key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys).",
      },
      { text: "Paste it below. It starts with `sk-`." },
    ],
    docs: { label: "dsh guide", href: `${DOCS}/provider-auth/dsh` },
    fields: [{ key: "DEEPSEEK_API_KEY", label: "API key", kind: "pool", placeholder: "sk-..." }],
  },
  {
    id: "xai",
    name: "xAI Grok",
    group: "api-key",
    type: "API key",
    logo: { src: "/provider-logos/xai.svg" },
    harnesses: ["grok"],
    noun: "key",
    vendor: "xAI",
    poolVar: "XAI_API_KEY",
    liveCheck: true,
    summary:
      "The xAI Grok CLI. grok workers can also run OpenRouter models with the OpenRouter key.",
    steps: [
      { text: "Create a key at [console.x.ai](https://console.x.ai)." },
      { text: "Paste it below. It starts with `xai-`." },
    ],
    docs: { label: "Grok guide", href: `${DOCS}/provider-auth/grok` },
    fields: [{ key: "XAI_API_KEY", label: "API key", kind: "pool", placeholder: "xai-..." }],
  },
  {
    id: "amp",
    name: "Amp",
    group: "api-key",
    type: "API key",
    logo: { provider: "amp" },
    harnesses: ["amp"],
    noun: "token",
    vendor: "Amp",
    poolVar: "AMP_API_KEY",
    liveCheck: false,
    summary: "Workers on Sourcegraph's Amp CLI. Amp bills its own usage.",
    steps: [
      {
        text: "Open [ampcode.com/settings/security](https://ampcode.com/settings/security#access-token).",
      },
      { text: "Create an access token. It starts with `sgamp_`." },
      { text: "Paste it below." },
    ],
    docs: { label: "Amp guide", href: `${DOCS}/provider-auth/amp` },
    fields: [{ key: "AMP_API_KEY", label: "Access token", kind: "pool", placeholder: "sgamp_..." }],
  },
  {
    id: "cursor",
    name: "Cursor",
    group: "api-key",
    type: "API key",
    logo: { letter: "C" },
    harnesses: ["cursor"],
    noun: "key",
    vendor: "Cursor",
    poolVar: "CURSOR_API_KEY",
    liveCheck: false,
    summary: "Workers on the Cursor agent. Cursor bills its own usage.",
    steps: [
      { text: "Create a key at [cursor.com/dashboard/api](https://cursor.com/dashboard/api)." },
      { text: "Paste it below. It starts with `key_`." },
    ],
    docs: { label: "Cursor guide", href: `${DOCS}/provider-auth/cursor` },
    fields: [{ key: "CURSOR_API_KEY", label: "API key", kind: "pool", placeholder: "key_..." }],
  },
  {
    id: "devin",
    name: "Devin",
    group: "api-key",
    type: "API key",
    logo: { src: "/harness-logos/devin.svg" },
    harnesses: ["devin"],
    noun: "key",
    vendor: "Devin",
    poolVar: "DEVIN_API_KEY",
    liveCheck: false,
    summary: "Managed cloud agents from app.devin.ai.",
    steps: [
      {
        text: "In [app.devin.ai](https://app.devin.ai), create a service user key or a personal access token.",
      },
      { text: "Copy your organization ID." },
      { text: "Paste both below." },
    ],
    docs: { label: "Harness providers guide", href: `${DOCS}/harness-providers` },
    fields: [
      { key: "DEVIN_API_KEY", label: "API key", kind: "pool", placeholder: "cog_..." },
      { key: "DEVIN_ORG_ID", label: "Organization ID", kind: "text", placeholder: "org_..." },
    ],
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    group: "api-key",
    type: "API key",
    logo: { provider: "amazon-bedrock" },
    harnesses: ["Claude Code", "pi"],
    noun: "setup",
    vendor: "AWS",
    configuredBy: ["AWS_REGION"],
    liveCheck: false,
    summary:
      "Routes pi and Claude Code calls to Bedrock. Auth goes through the AWS SDK credential chain.",
    steps: [
      { text: "Pick a region where Bedrock serves your models." },
      {
        text: "Leave the keys empty to use a profile, AWS SSO or an assumed role on the workers. Or paste static keys below.",
      },
      { text: "For pi, set the model with the `amazon-bedrock/` prefix." },
    ],
    docs: {
      label: "Bedrock auth guide",
      href: `${DOCS}/harness-providers#pi-mono--amazon-bedrock-auth`,
    },
    fields: [
      { key: "AWS_REGION", label: "AWS region", kind: "text", placeholder: "us-east-1" },
      {
        key: "AWS_ACCESS_KEY_ID",
        label: "Access key ID",
        kind: "secret",
        optional: true,
        placeholder: "AKIA...",
      },
      {
        key: "AWS_SECRET_ACCESS_KEY",
        label: "Secret access key",
        kind: "secret",
        optional: true,
        placeholder: "Paste the secret key",
      },
      {
        key: "MODEL_OVERRIDE",
        label: "pi model",
        kind: "text",
        optional: true,
        placeholder: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      },
    ],
    settingsPath: "/integrations/bedrock",
  },
  {
    id: "claude-managed",
    name: "Claude Managed Agents",
    group: "api-key",
    type: "API key",
    logo: { src: "/harness-logos/claude-managed.svg" },
    harnesses: ["claude-managed"],
    noun: "setup",
    vendor: "Anthropic",
    configuredBy: ["MANAGED_AGENT_ID", "MANAGED_ENVIRONMENT_ID"],
    liveCheck: false,
    summary: "Runs swarm tasks in Anthropic's cloud sandbox.",
    steps: [
      {
        text: "Run this once. It creates the agent and the environment at Anthropic.",
        command: "bunx @desplega.ai/agent-swarm claude-managed-setup",
      },
      { text: "Paste the IDs that it prints below." },
    ],
    docs: {
      label: "Managed Agents guide",
      href: `${DOCS}/harness-configuration#claude-managed-agents`,
    },
    fields: [
      {
        key: "ANTHROPIC_API_KEY",
        label: "Anthropic API key",
        kind: "pool",
        placeholder: "sk-ant-...",
      },
      {
        key: "MANAGED_AGENT_ID",
        label: "Managed agent ID",
        kind: "text",
        placeholder: "agent_...",
      },
      {
        key: "MANAGED_ENVIRONMENT_ID",
        label: "Managed environment ID",
        kind: "text",
        placeholder: "env_...",
      },
      {
        key: "MCP_BASE_URL",
        label: "MCP base URL",
        kind: "text",
        placeholder: "https://api.swarm.example.com",
        help: "Must be public HTTPS, so the sandbox can reach /mcp.",
      },
    ],
    settingsPath: "/integrations/claude-managed",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    group: "gateway",
    type: "Gateway",
    logo: { provider: "openrouter" },
    harnesses: ["pi", "opencode", "dsh", "grok", "fx"],
    noun: "key",
    vendor: "OpenRouter",
    poolVar: "OPENROUTER_API_KEY",
    liveCheck: true,
    summary:
      "Claude, Gemini, GPT, Mistral and more through one key. Agents rotate across the keys.",
    steps: [
      {
        text: "Create a key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys).",
      },
      { text: "Paste it below. It starts with `sk-or-v1-`." },
    ],
    docs: { label: "Model gateways guide", href: `${DOCS}/provider-auth/model-gateways` },
    fields: [
      { key: "OPENROUTER_API_KEY", label: "API key", kind: "pool", placeholder: "sk-or-v1-..." },
    ],
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    group: "gateway",
    type: "Gateway",
    logo: { provider: "vercel" },
    harnesses: ["pi", "opencode", "fx"],
    noun: "key",
    vendor: "Vercel",
    poolVar: "AI_GATEWAY_API_KEY",
    liveCheck: true,
    summary:
      "Every AI Gateway chat model (GLM, Kimi, Claude, GPT, Gemini and more), including Token Pass.",
    steps: [
      { text: "In the Vercel dashboard, open AI Gateway, API keys, and create a key." },
      { text: "Paste it below." },
    ],
    note: "Use a Token Pass API key for Token Pass credit. Regular keys use AI Gateway credit.",
    docs: GATEWAY_GUIDE,
    fields: [{ key: "AI_GATEWAY_API_KEY", label: "API key", kind: "pool", placeholder: "vck_..." }],
  },
  {
    id: "nan",
    name: "NaN",
    group: "gateway",
    type: "Gateway",
    logo: { provider: "nan" },
    harnesses: ["pi", "opencode"],
    noun: "key",
    vendor: "NaN",
    poolVar: "NAN_API_KEY",
    liveCheck: true,
    summary: "Open-weight models such as GLM, Qwen and DeepSeek for the pi and opencode harnesses.",
    steps: [{ text: "Create a key in your NaN account." }, { text: "Paste it below." }],
    note: "`HELMCODE_API_NAN` also works as the key name.",
    docs: GATEWAY_GUIDE,
    fields: [
      { key: "NAN_API_KEY", label: "API key", kind: "pool", placeholder: "sk-..." },
      {
        key: "NAN_BASE_URL",
        label: "Base URL",
        kind: "text",
        optional: true,
        placeholder: "https://api.nan.builders/v1",
        help: "OpenAI-compatible API root. Leave it empty for the default.",
      },
    ],
  },
  {
    id: "helmcode",
    name: "Helmcode",
    group: "gateway",
    type: "Gateway",
    logo: { provider: "helmcode" },
    harnesses: ["pi", "opencode"],
    noun: "key",
    vendor: "Helmcode",
    poolVar: "HELMCODE_API_KEY",
    liveCheck: true,
    summary: "Open-weight models through Helmcode for the pi and opencode harnesses.",
    steps: [{ text: "Create a key in your Helmcode organization." }, { text: "Paste it below." }],
    note: "Helmcode org plans include 5, 15 or 40 keys. Add them all: agents rotate across them.",
    docs: GATEWAY_GUIDE,
    fields: [
      { key: "HELMCODE_API_KEY", label: "API key", kind: "pool", placeholder: "sk-..." },
      {
        key: "HELMCODE_BASE_URL",
        label: "Base URL",
        kind: "text",
        optional: true,
        placeholder: "https://api.helmcode.com/v1",
        help: "OpenAI-compatible API root. Leave it empty for the default.",
      },
    ],
  },
  {
    id: "gateway",
    name: "Your own gateway",
    group: "gateway",
    type: "Gateway",
    logo: { lucide: "route" },
    harnesses: ["pi", "opencode"],
    noun: "key",
    vendor: "Your gateway",
    configuredBy: ["OPENROUTER_BASE_URL"],
    liveCheck: true,
    summary:
      "Any OpenAI-compatible chat completions endpoint, such as LiteLLM. It takes the place of openrouter.ai for the open harnesses.",
    steps: [
      { text: "Make sure the gateway serves `/models` and `/chat/completions`." },
      { text: "Save its URL first, then add a key. The API checks the key at that URL." },
    ],
    docs: { label: "Model gateways guide", href: `${DOCS}/provider-auth/model-gateways` },
    fields: [
      {
        key: "OPENROUTER_BASE_URL",
        label: "Gateway URL",
        kind: "text",
        placeholder: "https://gateway.example.com/v1",
      },
      {
        key: "OPENROUTER_API_KEY",
        label: "API key",
        kind: "pool",
        placeholder: "Paste the gateway key",
      },
    ],
  },
];

const WORKFLOWS_GUIDE = {
  label: "Workflows guide",
  href: "https://docs.agent-swarm.dev/docs/concepts/workflows#systemone-decision",
};
const SYSTEM_ONE_FOOTER = "The swarm checks the key before a workflow's first decision.";
const SECRETS_NOTE = "Saved as a global secret. Only the API server reads it.";

/**
 * The side panels of the System One hosts (`?add=system-one-<host>`). Not in
 * the Add menu: the System One tab opens them. OpenRouter has none: its row
 * opens the LLMs panel, because the key is the same pool.
 */
export const SYSTEM_ONE_SETUP: AiProvider[] = [
  {
    id: "system-one-typesafe",
    name: "Jev via TypeSafe",
    group: "api-key",
    type: "System One",
    logo: { letter: "T" },
    harnesses: ["workflow decisions"],
    noun: "key",
    vendor: "TypeSafe",
    configuredBy: ["TYPESAFE_API_KEY"],
    liveCheck: false,
    summary: "Jev answers typed decisions for workflow nodes, gates and scripts.",
    steps: [
      { text: "Get a TypeSafe API key from your TypeSafe account." },
      { text: "Paste it below." },
    ],
    docs: WORKFLOWS_GUIDE,
    footer: SYSTEM_ONE_FOOTER,
    fields: [
      {
        key: "TYPESAFE_API_KEY",
        label: "API key",
        kind: "secret",
        placeholder: "Paste the TypeSafe key",
        help: SECRETS_NOTE,
      },
    ],
  },
  {
    id: "system-one-cloudflare",
    name: "Clef via Cloudflare",
    group: "api-key",
    type: "System One",
    logo: { lucide: "cloud" },
    harnesses: ["workflow decisions", "extraction"],
    noun: "token",
    vendor: "Cloudflare",
    configuredBy: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    liveCheck: false,
    summary: "Workers AI runs Clef and Clef-flash for decisions, and Clairic for typed extraction.",
    steps: [
      {
        text: "In the [Cloudflare dashboard](https://dash.cloudflare.com), create an API token with Workers AI access.",
      },
      { text: "Copy the 32-character account id from the account's overview page." },
      { text: "Paste both below." },
    ],
    note: "`CLOUDFLARE_API_KEY` is read when `CLOUDFLARE_API_TOKEN` is unset.",
    docs: WORKFLOWS_GUIDE,
    footer: SYSTEM_ONE_FOOTER,
    fields: [
      {
        key: "CLOUDFLARE_API_TOKEN",
        label: "API token",
        kind: "secret",
        placeholder: "Paste the Workers AI token",
        help: SECRETS_NOTE,
      },
      {
        key: "CLOUDFLARE_ACCOUNT_ID",
        label: "Account ID",
        kind: "text",
        placeholder: "32 hex characters",
      },
    ],
  },
  {
    id: "system-one-laya",
    name: "laya",
    group: "api-key",
    type: "System One",
    logo: { letter: "la" },
    harnesses: ["workflow decisions"],
    noun: "key",
    vendor: "laya",
    configuredBy: ["LAYA_API_KEY", "LAYA_URL"],
    liveCheck: false,
    summary:
      "Your own laya server. This swarm's API server calls it directly, with no desplega API in between.",
    steps: [
      {
        text: "Run a laya server: `@desplega.ai/laya-server` from [laya-js](https://github.com/desplega-ai/laya-js), from npm or built from its Dockerfile.",
      },
      { text: "Paste its base URL below. The API server must reach it." },
      { text: "Paste the token that you gave the server." },
    ],
    note: "laya has no default model. It picks a checkpoint from the text, and the run output names it. Prefer choice questions on laya for now.",
    docs: WORKFLOWS_GUIDE,
    footer: SYSTEM_ONE_FOOTER,
    fields: [
      {
        key: "LAYA_URL",
        label: "Server URL",
        kind: "text",
        placeholder: "https://laya.example.com",
        help: "https only. Plain http works for localhost only.",
      },
      {
        key: "LAYA_API_KEY",
        label: "API key",
        kind: "secret",
        placeholder: "The token that the server expects",
        help: SECRETS_NOTE,
      },
    ],
  },
  {
    id: "system-one-openai",
    name: "OpenAI decisions",
    group: "api-key",
    type: "System One",
    logo: { provider: "openai" },
    harnesses: ["workflow decisions"],
    noun: "key",
    vendor: "OpenAI",
    configuredBy: ["OPENAI_DECISIONS_API_KEY"],
    liveCheck: false,
    summary: "The OpenAI Decisions API (`gpt-6-luna`) for typed decisions.",
    steps: [
      {
        text: "Create a key with Decisions access at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).",
      },
      { text: "Paste it below." },
    ],
    note: "A separate key from `OPENAI_API_KEY`, so this node never changes how agents sign in.",
    docs: WORKFLOWS_GUIDE,
    footer: SYSTEM_ONE_FOOTER,
    fields: [
      {
        key: "OPENAI_DECISIONS_API_KEY",
        label: "API key",
        kind: "secret",
        placeholder: "sk-...",
        help: SECRETS_NOTE,
      },
    ],
  },
];

export function findAiProvider(id: string): AiProvider | undefined {
  return AI_PROVIDERS.find((p) => p.id === id) ?? SYSTEM_ONE_SETUP.find((p) => p.id === id);
}

/** Providers whose name, id, harness or group matches the query. */
export function matchAiProviders(providers: AiProvider[], query: string): AiProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return providers;
  return providers.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.id.includes(q) ||
      p.type.toLowerCase().includes(q) ||
      p.harnesses.some((h) => h.toLowerCase().includes(q)),
  );
}

/** Pool vars the list reads, in registry order. `CODEX_OAUTH` is excluded: it is the accounts route. */
export const LIST_POOL_VARS: string[] = AI_PROVIDERS.flatMap((p) =>
  p.poolVar && p.poolVar !== "CODEX_OAUTH" ? [p.poolVar] : [],
);

// ─── Key health and the provider roll-up ────────────────────────────────────

/** The sidebar dot and the LLMs tab dot: any key rate limited or rejected by its provider. */
export function isUnhealthyKey(key: ApiKeyStatus): boolean {
  return key.status === "rate_limited" || key.lastValidationFailedAt != null;
}

/**
 * The count behind the sidebar dot and the LLMs tab dot: unhealthy key status
 * rows, plus ChatGPT accounts that need a new sign-in (each counted once).
 */
export function unhealthyCredentialCount(
  statuses: ApiKeyStatus[] | undefined,
  codexAccounts: CodexAccount[] | undefined,
): number {
  const unhealthy = (statuses ?? []).filter(isUnhealthyKey);
  const counted = new Set(
    unhealthy.filter((s) => s.keyType === "CODEX_OAUTH").map((s) => s.keySuffix),
  );
  const signIns = (codexAccounts ?? []).filter(
    (a) => a.status === "needs_login" && !(a.suffix && counted.has(a.suffix)),
  );
  return unhealthy.length + signIns.length;
}

export type KeyHealth = "ok" | "unchecked" | "limited" | "failing";

/** Worst first: the roll-up of a provider takes the first state any key has. */
const HEALTH_ORDER: KeyHealth[] = ["failing", "limited", "unchecked", "ok"];

export interface ProviderKey {
  /** Stable React key. */
  id: string;
  keyType: string;
  suffix: string | null;
  /** Pool index, or the ChatGPT account slot. */
  index: number;
  /** Shown name: the label, the ChatGPT email, or "Key ending abcde". */
  label: string;
  /** The label set from the dashboard, or null. */
  name: string | null;
  health: KeyHealth;
  /** Why the key is failing or limited ("HTTP 401", "Sign in again"). */
  reason: string | null;
  rateLimitedUntil: string | null;
  lastUsedAt: string | null;
  plan: string | null;
  planSource: ApiKeyStatus["planSource"];
  /** 0 to 100, when the provider reports the window (Claude tokens). */
  window5h: number | null;
  window7d: number | null;
  costToday: number;
  cost7d: number;
  /** The `api_key_status` row: rename, set plan and clear rate limit need it. */
  status: ApiKeyStatus | null;
}

export interface ProviderRow {
  provider: AiProvider;
  keys: ProviderKey[];
  health: KeyHealth;
  /** Keys in the worst state, for the chip ("2 rate limited"). */
  worstCount: number;
  /** The first worst key's reason, under the chip on a collapsed row. */
  reason: string | null;
  costToday: number;
  cost7d: number;
  /** The pool comes from the deployment env: keys change there, not here. */
  readOnly: boolean;
  /**
   * Set up with plain config fields, no pool (Bedrock, Claude Managed Agents,
   * your own gateway): no keys to list, so the row opens the setup panel.
   */
  configOnly?: boolean;
}

export function rollUpHealth(keys: { health: KeyHealth }[]): KeyHealth {
  for (const state of HEALTH_ORDER) {
    if (keys.some((k) => k.health === state)) return state;
  }
  return "ok";
}

function poolKeyHealth(key: PoolKey): KeyHealth {
  if (key.status === "rejected") return "failing";
  if (key.status === "rate_limited") return "limited";
  if (key.status === "unchecked") return "unchecked";
  return "ok";
}

function codexHealth(account: CodexAccount): KeyHealth {
  if (account.status === "needs_login") return "failing";
  if (account.status === "unchecked") return "unchecked";
  return "ok";
}

/** A utilization fraction (0..1) as a whole percent. */
function windowPercent(status: ApiKeyStatus | null, window: string): number | null {
  const value = status?.rateLimitWindows?.[window]?.utilization;
  return typeof value === "number" ? Math.round(value * 100) : null;
}

function costFor(
  rows: UsageSummaryByCredentialRow[] | undefined,
  keyType: string,
  suffix: string | null,
): number {
  if (!suffix) return 0;
  const row = rows?.find((r) => r.keyType === keyType && r.keySuffix === suffix);
  return row?.costUsd ?? 0;
}

/** The rate-limit clock time, with the date when it is not today. */
export function backAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function keyReason(key: ProviderKey): string | null {
  if (key.health === "failing") return `${key.label}: ${key.reason ?? "rejected"}`;
  if (key.health === "limited") {
    return key.rateLimitedUntil
      ? `${key.label} is back at ${backAt(key.rateLimitedUntil)}`
      : `${key.label} is rate limited`;
  }
  return null;
}

export interface ProviderRowsInput {
  /** `GET /api/config/pool-keys` per pool var, for the vars that are set. */
  pools: Record<string, { keys: PoolKey[]; readOnly: boolean } | undefined>;
  codexAccounts: CodexAccount[] | undefined;
  statuses: ApiKeyStatus[] | undefined;
  /** `byCredential` of the usage summary since the start of today. */
  usageToday: UsageSummaryByCredentialRow[] | undefined;
  /** `byCredential` of the usage summary of the last 7 days. */
  usage7d: UsageSummaryByCredentialRow[] | undefined;
  /** Env presence of the `configuredBy` keys, for the providers without a pool. */
  presence?: Record<string, boolean>;
}

/**
 * One row per provider with at least one key or account, in registry order,
 * plus one per provider without a pool whose `configuredBy` keys are all set.
 * Pool members come from the pool route (what is stored); the key status
 * rows add the name, plan, usage windows and last use.
 */
export function buildProviderRows(input: ProviderRowsInput): ProviderRow[] {
  const statusFor = (keyType: string, suffix: string | null) =>
    suffix
      ? (input.statuses?.find(
          (s) => s.keyType === keyType && s.keySuffix === suffix && s.scope === "global",
        ) ?? null)
      : null;

  function makeKey(
    keyType: string,
    index: number,
    suffix: string | null,
    fallbackLabel: string,
    health: KeyHealth,
    reason: string | null,
    rateLimitedUntil: string | null,
  ): ProviderKey {
    const status = statusFor(keyType, suffix);
    return {
      id: `${keyType}:${index}:${suffix ?? ""}`,
      keyType,
      suffix,
      index,
      label: status?.name || fallbackLabel,
      name: status?.name ?? null,
      health,
      reason,
      rateLimitedUntil: rateLimitedUntil ?? status?.rateLimitedUntil ?? null,
      lastUsedAt: status?.lastUsedAt ?? null,
      plan: status?.plan ?? null,
      planSource: status?.planSource ?? null,
      window5h: windowPercent(status, "five_hour"),
      window7d: windowPercent(status, "seven_day"),
      costToday: costFor(input.usageToday, keyType, suffix),
      cost7d: costFor(input.usage7d, keyType, suffix),
      status,
    };
  }

  const rows: ProviderRow[] = [];
  for (const provider of AI_PROVIDERS) {
    const poolVar = provider.poolVar;
    if (!poolVar) {
      const configured = provider.configuredBy?.every((key) => input.presence?.[key] === true);
      if (configured) {
        rows.push({
          provider,
          keys: [],
          health: "ok",
          worstCount: 0,
          reason: null,
          costToday: 0,
          cost7d: 0,
          readOnly: false,
          configOnly: true,
        });
      }
      continue;
    }
    let keys: ProviderKey[] = [];
    let readOnly = false;
    if (poolVar === "CODEX_OAUTH") {
      keys = (input.codexAccounts ?? []).map((account) =>
        makeKey(
          poolVar,
          account.slot,
          account.suffix,
          account.email ?? `Account in slot ${account.slot}`,
          codexHealth(account),
          account.status === "needs_login" ? "sign in again" : null,
          null,
        ),
      );
    } else {
      const pool = input.pools[poolVar];
      readOnly = pool?.readOnly ?? false;
      keys = (pool?.keys ?? []).map((key) =>
        makeKey(
          poolVar,
          key.index,
          key.suffix,
          `Key ending ${key.suffix}`,
          poolKeyHealth(key),
          key.error,
          key.rateLimitedUntil,
        ),
      );
    }
    if (keys.length === 0) continue;
    const health = rollUpHealth(keys);
    const worst = keys.filter((k) => k.health === health);
    rows.push({
      provider,
      keys,
      health,
      worstCount: worst.length,
      reason: worst[0] ? keyReason(worst[0]) : null,
      costToday: keys.reduce((sum, k) => sum + k.costToday, 0),
      cost7d: keys.reduce((sum, k) => sum + k.cost7d, 0),
      readOnly,
    });
  }
  return rows;
}

/** "3 tokens", "1 account", "2 keys". */
export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The chip text of a provider row. */
export function healthLabel(row: Pick<ProviderRow, "health" | "worstCount">): string {
  switch (row.health) {
    case "failing":
      return "Failing";
    case "limited":
      return `${row.worstCount} rate limited`;
    case "unchecked":
      return "Not checked yet";
    default:
      return "Healthy";
  }
}
