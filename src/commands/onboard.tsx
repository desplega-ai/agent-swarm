import crypto from "node:crypto";
import { Select } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import pkg from "../../package.json";
import { getAgentSummary, getPresetById, PRESETS } from "./onboard/presets.ts";
import { CoreCredentialsStep } from "./onboard/steps/core-credentials.tsx";
import { CustomTemplatesStep } from "./onboard/steps/custom-templates.tsx";
import { GenerateStep } from "./onboard/steps/generate.tsx";
import { HarnessStep } from "./onboard/steps/harness.tsx";
import { HarnessCredentialsStep } from "./onboard/steps/harness-credentials.tsx";
import { HealthCheckStep } from "./onboard/steps/health-check.tsx";
import { IntegrationGitHubStep } from "./onboard/steps/integration-github.tsx";
import { IntegrationGitLabStep } from "./onboard/steps/integration-gitlab.tsx";
import { IntegrationMenuStep } from "./onboard/steps/integration-menu.tsx";
import { IntegrationSentryStep } from "./onboard/steps/integration-sentry.tsx";
import { IntegrationSlackStep } from "./onboard/steps/integration-slack.tsx";
import { PostConnectStep } from "./onboard/steps/post-connect.tsx";
import { PostDashboardStep } from "./onboard/steps/post-dashboard.tsx";
import { PostTaskStep } from "./onboard/steps/post-task.tsx";
import { PrereqCheckStep } from "./onboard/steps/prereq-check.tsx";
import { ReviewStep } from "./onboard/steps/review.tsx";
import { StartStep } from "./onboard/steps/start.tsx";
import {
  INITIAL_STATE,
  nextStep,
  type OnboardProps,
  type OnboardState,
  type OnboardStep,
  type StepProps,
} from "./onboard/types.ts";

const BANNER = `
   _                    _     ____
  / \\   __ _  ___ _ __ | |_  / ___|_      ____ _ _ __ _ __ ___
 / _ \\ / _\` |/ _ \\ '_ \\| __| \\___ \\ \\ /\\ / / _\` | '__| '_ \` _ \\
/ ___ \\ (_| |  __/ | | | |_   ___) \\ V  V / (_| | |  | | | | | |
/_/   \\_\\__, |\\___|_| |_|\\__| |____/ \\_/\\_/ \\__,_|_|  |_| |_| |_|
       |___/
`;

export function Onboard({ dryRun = false, yes = false, preset }: OnboardProps) {
  const { exit } = useApp();
  const [state, setState] = useState<OnboardState>(() => {
    const initial = { ...INITIAL_STATE };
    if (preset) {
      initial.presetId = preset;
    }
    return initial;
  });

  const executedSteps = useRef<Set<OnboardStep>>(new Set());

  const addLog = useCallback(
    (log: string, isDryRunAction = false) => {
      const prefix = isDryRunAction && dryRun ? "[DRY-RUN] Would: " : "";
      setState((s) => ({ ...s, logs: [...s.logs, `${prefix}${log}`] }));
    },
    [dryRun],
  );

  const goToStep = useCallback((step: OnboardStep, partial?: Partial<OnboardState>) => {
    setState((s) => ({ ...s, ...partial, step }));
  }, []);

  const goToNext = useCallback((partial?: Partial<OnboardState>) => {
    setState((s) => {
      const updated = { ...s, ...partial };
      const next = nextStep(s.step, updated);
      return { ...updated, step: next };
    });
  }, []);

  const goToError = useCallback((error: string) => {
    setState((s) => ({ ...s, step: "error", error }));
  }, []);

  // Exit on done/error
  useEffect(() => {
    if (state.step === "done" || state.step === "error") {
      const timer = setTimeout(() => exit(), 500);
      return () => clearTimeout(timer);
    }
  }, [state.step, exit]);

  // --yes mode: bootstrap full state from env vars and jump to generate
  useEffect(() => {
    if (!yes) return;
    if (state.step !== "welcome") return;
    if (executedSteps.current.has("welcome")) return;
    executedSteps.current.add("welcome");

    addLog("Non-interactive mode (--yes)");

    // Require --preset
    if (!preset) {
      goToError(
        "--preset is required in non-interactive mode (--yes). Options: dev, content, research, solo",
      );
      return;
    }

    const selectedPreset = getPresetById(preset);
    if (!selectedPreset || preset === "custom") {
      goToError(`Invalid preset "${preset}". Options: dev, content, research, solo`);
      return;
    }

    // Read credentials from env
    const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!claudeToken) {
      goToError("CLAUDE_CODE_OAUTH_TOKEN environment variable is required in non-interactive mode");
      return;
    }

    const apiKey = process.env.API_KEY || crypto.randomBytes(16).toString("hex");

    // Auto-generate agent IDs
    const agentIds: Record<string, string> = {};
    for (const svc of selectedPreset.services) {
      if (svc.count === 1) {
        const name = svc.isLead ? "lead" : `worker-${svc.role}`;
        agentIds[name] = crypto.randomUUID();
      } else {
        for (let i = 1; i <= svc.count; i++) {
          const name = `worker-${svc.role}-${i}`;
          agentIds[name] = crypto.randomUUID();
        }
      }
    }

    // Auto-detect integrations from env vars
    const integrations = {
      github: !!process.env.GITHUB_TOKEN,
      slack: !!process.env.SLACK_BOT_TOKEN,
      gitlab: !!process.env.GITLAB_TOKEN,
      sentry: !!process.env.SENTRY_AUTH_TOKEN,
    };

    addLog(
      `Preset: ${selectedPreset.name} (${selectedPreset.services.reduce((s, e) => s + e.count, 0)} agents)`,
    );
    addLog(`Harness: claude`);
    if (Object.values(integrations).some(Boolean)) {
      const enabled = Object.entries(integrations)
        .filter(([, v]) => v)
        .map(([k]) => k);
      addLog(`Integrations: ${enabled.join(", ")}`);
    }

    goToStep("generate", {
      nonInteractive: true,
      deployType: "local",
      presetId: selectedPreset.id,
      services: selectedPreset.services,
      harness: "claude",
      claudeOAuthToken: claudeToken,
      apiKey,
      agentIds,
      integrations,
      githubToken: process.env.GITHUB_TOKEN || "",
      githubEmail: process.env.GITHUB_EMAIL || "",
      githubName: process.env.GITHUB_NAME || "",
      slackBotToken: process.env.SLACK_BOT_TOKEN || "",
      slackAppToken: process.env.SLACK_APP_TOKEN || "",
      gitlabToken: process.env.GITLAB_TOKEN || "",
      gitlabEmail: process.env.GITLAB_EMAIL || "",
      sentryToken: process.env.SENTRY_AUTH_TOKEN || "",
      sentryOrg: process.env.SENTRY_ORG || "",
    });
  }, [yes, preset, state.step, addLog, goToStep, goToError]);

  // Interactive welcome: auto-advance after detecting existing setup
  useEffect(() => {
    if (yes) return;
    if (state.step !== "welcome") return;
    if (executedSteps.current.has("welcome")) return;
    executedSteps.current.add("welcome");

    const checkExisting = async () => {
      const manifestFile = Bun.file(`${state.outputDir}/.agent-swarm/config.json`);
      if (await manifestFile.exists()) {
        addLog("Existing .agent-swarm/config.json detected");
      }
      goToStep("deploy_type");
    };

    checkExisting().catch((err) => goToError(err.message));
  }, [yes, state.step, state.outputDir, addLog, goToStep, goToError]);

  // Build step props to pass to all step components
  const stepProps: StepProps = { state, dryRun, addLog, goToNext, goToStep, goToError };

  // --- Render by step ---

  if (state.step === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Onboard failed: {state.error}</Text>
      </Box>
    );
  }

  if (state.step === "welcome") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          {BANNER}
        </Text>
        <Text dimColor>v{pkg.version}</Text>
        {dryRun && (
          <Text color="yellow" bold>
            DRY-RUN MODE
          </Text>
        )}
        <Box marginTop={1}>
          <Text dimColor>Checking for existing setup...</Text>
        </Box>
      </Box>
    );
  }

  if (state.step === "deploy_type") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          {BANNER}
        </Text>
        <Text dimColor>v{pkg.version}</Text>
        {dryRun && (
          <Text color="yellow" bold>
            DRY-RUN MODE
          </Text>
        )}
        <Logs logs={state.logs} />
        <Box marginTop={1} flexDirection="column">
          <Text bold>How would you like to deploy your swarm?</Text>
          <Box marginTop={1}>
            <Select
              options={[
                { label: "Local (Docker Compose)", value: "local" },
                { label: "Remote (SSH) — Coming soon", value: "remote" },
              ]}
              onChange={(value) => {
                if (value === "remote") {
                  addLog("Remote deploy will be available in a future release.");
                  return;
                }
                goToNext({ deployType: "local" });
              }}
            />
          </Box>
        </Box>
      </Box>
    );
  }

  if (state.step === "preset") {
    return (
      <Box flexDirection="column" padding={1}>
        <Logs logs={state.logs} />
        <Text bold>Choose a swarm preset:</Text>
        <Box marginTop={1}>
          <Select
            options={PRESETS.map((p) => ({
              label: `${p.name}${p.services.length > 0 ? ` (${getAgentSummary(p.services)})` : ""}`,
              value: p.id,
            }))}
            onChange={(value) => {
              const selected = getPresetById(value);
              if (!selected) return;
              goToNext({ presetId: selected.id, services: selected.services });
            }}
          />
        </Box>
      </Box>
    );
  }

  if (state.step === "custom_templates") return <CustomTemplatesStep {...stepProps} />;
  if (state.step === "harness") return <HarnessStep {...stepProps} />;
  if (state.step === "harness_credentials") return <HarnessCredentialsStep {...stepProps} />;
  if (state.step === "core_credentials") return <CoreCredentialsStep {...stepProps} />;
  if (state.step === "integration_menu") return <IntegrationMenuStep {...stepProps} />;
  if (state.step === "integration_github") return <IntegrationGitHubStep {...stepProps} />;
  if (state.step === "integration_slack") return <IntegrationSlackStep {...stepProps} />;
  if (state.step === "integration_gitlab") return <IntegrationGitLabStep {...stepProps} />;
  if (state.step === "integration_sentry") return <IntegrationSentryStep {...stepProps} />;
  if (state.step === "review") return <ReviewStep {...stepProps} />;
  if (state.step === "generate") return <GenerateStep {...stepProps} />;
  if (state.step === "prereq_check") return <PrereqCheckStep {...stepProps} />;
  if (state.step === "start") return <StartStep {...stepProps} />;
  if (state.step === "health_check") return <HealthCheckStep {...stepProps} />;
  if (state.step === "post_connect") return <PostConnectStep {...stepProps} />;
  if (state.step === "post_dashboard") return <PostDashboardStep {...stepProps} />;
  if (state.step === "post_task") return <PostTaskStep {...stepProps} />;

  if (state.step === "done") {
    const apiUrl = "http://localhost:3013";
    const dashUrl = `https://app.agent-swarm.dev?api_url=${apiUrl}&api_key=${state.apiKey}`;
    const agentCount = state.services.reduce((sum, s) => sum + s.count, 0);

    return (
      <Box flexDirection="column" padding={1}>
        {dryRun && (
          <Box marginBottom={1}>
            <Text color="yellow" bold>
              DRY-RUN MODE - No changes were made
            </Text>
          </Box>
        )}
        <Logs logs={state.logs} />
        <Box marginTop={1} flexDirection="column">
          <Text color="green" bold>
            Your swarm is running!
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              API: <Text color="cyan">{apiUrl}</Text>
            </Text>
            <Text>
              Dashboard: <Text color="cyan">{dashUrl}</Text>
            </Text>
            {agentCount > 0 && <Text>Agents: {agentCount} configured</Text>}
            <Text dimColor>Files: docker-compose.yml, .env, .agent-swarm/config.json</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Useful commands:</Text>
            <Text dimColor> docker compose logs -f</Text>
            <Text dimColor> docker compose down</Text>
            <Text dimColor> agent-swarm setup</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return null;
}

function Logs({ logs }: { logs: string[] }) {
  if (logs.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {logs.map((log, i) => (
        <Text key={`log-${i}-${log.slice(0, 20)}`} dimColor>
          {log}
        </Text>
      ))}
    </Box>
  );
}
