import { getPresetById } from "../../../commands/onboard/presets.ts";
import { INITIAL_STATE, type OnboardState } from "../../../commands/onboard/types.ts";

/**
 * Deterministic onboard states, one per unattended preset plus one variant
 * with every integration, Bedrock (profile) and Podman. The fixtures next to
 * this file hold the compose and .env these states rendered before the
 * agent-fs bundle existed, so flag-off output stays byte-identical.
 */
export const BASELINE_PRESET_IDS = ["full", "dev", "content", "research", "solo"] as const;

function agentIdsFor(state: Pick<OnboardState, "services">): Record<string, string> {
  const ids: Record<string, string> = {};
  let n = 0;
  const next = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  for (const svc of state.services) {
    if (svc.count === 1) {
      ids[svc.isLead ? "lead" : `worker-${svc.role}`] = next();
    } else {
      for (let i = 1; i <= svc.count; i++) ids[`worker-${svc.role}-${i}`] = next();
    }
  }
  return ids;
}

export function baselineState(presetId: string, variant: "default" | "all" = "default") {
  const preset = getPresetById(presetId);
  if (!preset) throw new Error(`unknown preset ${presetId}`);
  const base: OnboardState = {
    ...INITIAL_STATE,
    nonInteractive: true,
    presetId: preset.id,
    services: preset.services,
    apiKey: "example-test-api-key",
    claudeOAuthToken: "example-test-oauth",
    outputDir: "/tmp/onboard-fixture",
  };
  base.agentIds = agentIdsFor(base);
  if (variant === "default") return base;
  return {
    ...base,
    provider: "bedrock",
    harness: "pi",
    awsRegion: "us-east-1",
    awsProfile: "example-profile",
    modelOverride: "example-model",
    containerEngine: "podman",
    pullPolicy: "missing",
    apiPort: 3999,
    maxConcurrentTasks: 3,
    integrations: { github: true, slack: true, gitlab: true, sentry: true },
    githubToken: "example-gh",
    githubEmail: "dev@example.com",
    githubName: "Example Dev",
    slackBotToken: "example-slack-bot",
    slackSigningSecret: "example-slack-signing",
    slackMode: "http",
    gitlabToken: "example-gitlab",
    gitlabEmail: "dev@example.com",
    sentryToken: "example-sentry",
    sentryOrg: "example-org",
  } satisfies OnboardState;
}

export const BASELINE_CASES: { name: string; state: OnboardState }[] = [
  ...BASELINE_PRESET_IDS.map((id) => ({ name: id, state: baselineState(id) })),
  { name: "full-all", state: baselineState("full", "all") },
];
