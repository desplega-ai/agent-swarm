/**
 * Inputs for the base prompt byte-identity test and for
 * `scripts/capture-base-prompt-baseline.ts`, which renders them with a given
 * checkout's `getBasePrompt` into `base-prompt-baseline.json`.
 */
import type { BasePromptArgs } from "../../prompts/base-prompt";
import type { ProviderTraits } from "../../providers/types";

const minimalArgs: BasePromptArgs = {
  role: "worker",
  agentId: "11111111-2222-3333-4444-555555555555",
};
const localTraits: ProviderTraits = { hasMcp: true, hasLocalEnvironment: true };
const managedTraits: ProviderTraits = { hasMcp: true, hasLocalEnvironment: false };
const remoteTraits: ProviderTraits = { hasMcp: false, hasLocalEnvironment: false };

export const BASELINE_SKILLS = [
  { name: "alpha", description: "does alpha" },
  { name: "beta", description: "does beta things" },
];

const full: BasePromptArgs = {
  ...minimalArgs,
  name: "Tester",
  description: "A test agent",
  soulMd: "# Soul\n\nBe kind.\n\n\n\nReally.",
  identityMd: "# Custom identity\n\nEdited.",
  claudeMd: "# Notes\n\nCustom rules here.",
  skillsSummary: BASELINE_SKILLS,
  mcpServers: ["context7"],
};

export const BASELINE_ARGS: Record<string, BasePromptArgs> = {
  "claude worker": {
    ...full,
    provider: "claude",
    traits: { ...localTraits, hasToolSearch: true, steerModes: ["queue"] },
  },
  "claude lead": { ...full, role: "lead", provider: "claude", traits: localTraits },
  "scripts-only": { ...full, provider: "claude", scriptsOnly: true, traits: localTraits },
  codex: { ...full, provider: "codex", traits: { ...localTraits, nativeSkillDiscovery: false } },
  pi: { ...full, provider: "pi", traits: localTraits },
  managed: { ...full, provider: "claude-managed", traits: managedTraits },
  remote: { ...full, provider: "devin", traits: remoteTraits },
  minimal: minimalArgs,
};

/** Env each deployment sets on top of a cleared `BASELINE_ENV_KEYS`. */
export const BASELINE_DEPLOYMENTS: Record<string, Record<string, string>> = {
  plain: {},
  "slack + steering + agent-fs": {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_APP_TOKEN: "xapp-test-token",
    STEERING_ENABLED: "true",
    AGENT_FS_API_URL: "http://agent-fs.test",
  },
};

export const BASELINE_ENV_KEYS = [
  "SLACK_DISABLE",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_MODE",
  "SLACK_SIGNING_SECRET",
  "STEERING_ENABLED",
  "AGENT_FS_API_URL",
  "SCRIPTS_ONLY_MCP",
] as const;

export const baselineKey = (deployment: string, name: string): string => `${deployment} / ${name}`;
