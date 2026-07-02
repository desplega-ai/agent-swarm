export type OnboardStep =
  | "welcome"
  | "deploy_type"
  | "preset"
  | "custom_templates"
  | "harness"
  | "harness_credentials"
  | "core_credentials"
  | "integration_menu"
  | "integration_github"
  | "integration_slack"
  | "integration_gitlab"
  | "integration_sentry"
  | "review"
  | "generate"
  | "prereq_check"
  | "start"
  | "health_check"
  | "post_connect"
  | "post_dashboard"
  | "post_task"
  | "done"
  | "error";

export interface OnboardState {
  step: OnboardStep;
  deployType: "local" | "remote";
  presetId: string | null;
  services: ServiceEntry[];
  harness: "claude" | "pi";
  claudeOAuthToken: string;
  anthropicApiKey: string;
  credentialType: "oauth" | "api_key";
  apiKey: string;
  agentIds: Record<string, string>;
  integrations: {
    github: boolean;
    slack: boolean;
    gitlab: boolean;
    sentry: boolean;
  };
  githubToken: string;
  githubEmail: string;
  githubName: string;
  slackBotToken: string;
  slackAppToken: string;
  gitlabToken: string;
  gitlabEmail: string;
  sentryToken: string;
  sentryOrg: string;
  apiPort: number;
  outputDir: string;
  nonInteractive: boolean;
  error: string | null;
  logs: string[];
}

export interface ServiceEntry {
  template: string;
  displayName: string;
  count: number;
  role: string;
  isLead?: boolean;
}

export interface OnboardProps {
  dryRun?: boolean;
  yes?: boolean;
  preset?: string;
}

export interface StepProps {
  state: OnboardState;
  dryRun: boolean;
  addLog: (log: string, isDryRunAction?: boolean) => void;
  goToNext: (partial?: Partial<OnboardState>) => void;
  goToStep: (step: OnboardStep, partial?: Partial<OnboardState>) => void;
  goToError: (error: string) => void;
}

/** Ordered steps with labels for the progress indicator. */
export const STEP_LABELS: { step: OnboardStep; label: string }[] = [
  { step: "deploy_type", label: "Deploy" },
  { step: "preset", label: "Preset" },
  { step: "harness", label: "Harness" },
  { step: "harness_credentials", label: "Credentials" },
  { step: "core_credentials", label: "Keys" },
  { step: "integration_menu", label: "Integrations" },
  { step: "review", label: "Review" },
  { step: "generate", label: "Generate" },
  { step: "prereq_check", label: "Docker" },
  { step: "start", label: "Start" },
  { step: "health_check", label: "Health" },
  { step: "post_connect", label: "Connect" },
  { step: "done", label: "Done" },
];

/** Get progress info for the current step. */
export function getStepProgress(current: OnboardStep): {
  index: number;
  total: number;
  label: string;
} {
  const total = STEP_LABELS.length;
  // Find current or nearest match (integration sub-steps map to "Integrations")
  const integrationSteps: OnboardStep[] = [
    "integration_menu",
    "integration_github",
    "integration_slack",
    "integration_gitlab",
    "integration_sentry",
  ];
  const effectiveStep = integrationSteps.includes(current) ? "integration_menu" : current;
  const idx = STEP_LABELS.findIndex((s) => s.step === effectiveStep);
  if (idx === -1) {
    // custom_templates maps to preset
    if (current === "custom_templates") return { index: 1, total, label: "Preset" };
    // post_dashboard, post_task map to connect
    return { index: total - 1, total, label: "Done" };
  }
  return { index: idx, total, label: STEP_LABELS[idx]?.label ?? "" };
}

export const INITIAL_STATE: OnboardState = {
  step: "welcome",
  deployType: "local",
  presetId: null,
  services: [],
  harness: "claude",
  claudeOAuthToken: "",
  anthropicApiKey: "",
  credentialType: "oauth",
  apiKey: "",
  agentIds: {},
  integrations: { github: false, slack: false, gitlab: false, sentry: false },
  githubToken: "",
  githubEmail: "",
  githubName: "",
  slackBotToken: "",
  slackAppToken: "",
  gitlabToken: "",
  gitlabEmail: "",
  sentryToken: "",
  sentryOrg: "",
  apiPort: 0,
  outputDir: process.cwd(),
  nonInteractive: false,
  error: null,
  logs: [],
};

/**
 * Step transition DAG. Each step maps to its possible next steps.
 * The nextStep() function resolves which edge to follow based on current state.
 */
const STEP_DAG: Record<OnboardStep, OnboardStep[]> = {
  welcome: ["deploy_type"],
  deploy_type: ["preset"],
  preset: ["harness", "custom_templates"],
  custom_templates: ["harness"],
  harness: ["harness_credentials"],
  harness_credentials: ["core_credentials"],
  core_credentials: ["integration_menu"],
  integration_menu: [
    "integration_github",
    "integration_slack",
    "integration_gitlab",
    "integration_sentry",
    "review",
  ],
  integration_github: ["integration_slack", "integration_gitlab", "integration_sentry", "review"],
  integration_slack: ["integration_gitlab", "integration_sentry", "review"],
  integration_gitlab: ["integration_sentry", "review"],
  integration_sentry: ["review"],
  review: ["generate", "integration_menu"],
  generate: ["prereq_check"],
  prereq_check: ["start", "done"],
  start: ["health_check"],
  health_check: ["post_connect"],
  post_connect: ["post_dashboard"],
  post_dashboard: ["post_task", "done"],
  post_task: ["done"],
  done: [],
  error: [],
};

const INTEGRATION_STEPS: OnboardStep[] = [
  "integration_github",
  "integration_slack",
  "integration_gitlab",
  "integration_sentry",
];

const INTEGRATION_KEY_MAP: Record<string, keyof OnboardState["integrations"]> = {
  integration_github: "github",
  integration_slack: "slack",
  integration_gitlab: "gitlab",
  integration_sentry: "sentry",
};

/**
 * Resolve the next step from the DAG based on current state.
 * Handles branching logic: skips disabled integrations, routes solo preset
 * past post_task, etc.
 */
export function nextStep(current: OnboardStep, state: OnboardState): OnboardStep {
  const edges = STEP_DAG[current];
  if (edges.length === 0) return current;
  if (edges.length === 1) return edges[0] as OnboardStep;

  switch (current) {
    case "preset":
      // custom → custom_templates, otherwise → harness
      return state.presetId === "custom" ? "custom_templates" : "harness";

    case "integration_menu":
      // Find the first enabled integration, or review if none
      return findNextIntegrationOrReview(INTEGRATION_STEPS, state);

    case "integration_github":
      return findNextIntegrationOrReview(INTEGRATION_STEPS.slice(1), state);

    case "integration_slack":
      return findNextIntegrationOrReview(INTEGRATION_STEPS.slice(2), state);

    case "integration_gitlab":
      return findNextIntegrationOrReview(INTEGRATION_STEPS.slice(3), state);

    case "review":
      // "go back" is handled by explicit user choice, default is "generate"
      return "generate";

    case "prereq_check":
      // If Docker is missing and user chose "files only", skip to done
      // Default: proceed to start
      return "start";

    case "health_check":
      // Skip post-deploy steps in non-interactive mode
      return state.nonInteractive ? "done" : "post_connect";

    case "post_dashboard":
      // Solo preset has no lead → skip post_task
      return state.presetId === "solo" ? "done" : "post_task";

    default:
      return edges[0] as OnboardStep;
  }
}

function findNextIntegrationOrReview(candidates: OnboardStep[], state: OnboardState): OnboardStep {
  for (const step of candidates) {
    const key = INTEGRATION_KEY_MAP[step];
    if (key && state.integrations[key]) {
      return step;
    }
  }
  return "review";
}
