import { expandServices } from "./service-names.ts";
import type { OnboardState } from "./types.ts";

/**
 * Generate a JSON-serializable manifest object from onboard wizard state.
 * This manifest captures the full configuration for later reference,
 * upgrades, or re-generation.
 */
export function generateManifest(state: OnboardState): object {
  const expanded = expandServices(state.services, state.agentIds);

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    deployType: state.deployType,
    preset: state.presetId,
    harness: state.harness,
    services: expanded.map((svc) => ({
      name: svc.name,
      templateId: svc.entry.template,
      agentId: svc.agentId,
      role: svc.entry.isLead ? "lead" : "worker",
      displayName:
        svc.entry.count > 1 ? `${svc.entry.displayName} ${svc.index + 1}` : svc.entry.displayName,
    })),
    integrations: {
      github: state.integrations.github,
      slack: state.integrations.slack,
      gitlab: state.integrations.gitlab,
      sentry: state.integrations.sentry,
    },
    composePath: "./docker-compose.yml",
    envPath: "./.env",
    apiUrl: `http://localhost:${state.apiPort || 3013}`,
    dashboardUrl: "https://app.agent-swarm.dev",
  };
}
