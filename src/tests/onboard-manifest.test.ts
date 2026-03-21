import { describe, expect, test } from "bun:test";
import { generateManifest } from "../commands/onboard/manifest.ts";
import { INITIAL_STATE, type OnboardState } from "../commands/onboard/types.ts";

function makeState(overrides: Partial<OnboardState>): OnboardState {
  return { ...INITIAL_STATE, ...overrides };
}

describe("generateManifest", () => {
  const devState = makeState({
    presetId: "dev",
    deployType: "local",
    harness: "claude",
    services: [
      { template: "official/lead", displayName: "Lead", count: 1, role: "lead", isLead: true },
      { template: "official/coder", displayName: "Coder", count: 2, role: "coder" },
    ],
    agentIds: {
      lead: "lead-uuid",
      "worker-coder-1": "coder-uuid-1",
      "worker-coder-2": "coder-uuid-2",
    },
    integrations: { github: true, slack: false, gitlab: false, sentry: true },
  });

  // ── Schema shape ──

  test("manifest has required top-level fields", () => {
    const manifest = generateManifest(devState) as Record<string, unknown>;
    expect(manifest).toHaveProperty("version");
    expect(manifest).toHaveProperty("createdAt");
    expect(manifest).toHaveProperty("deployType");
    expect(manifest).toHaveProperty("preset");
    expect(manifest).toHaveProperty("harness");
    expect(manifest).toHaveProperty("services");
    expect(manifest).toHaveProperty("integrations");
    expect(manifest).toHaveProperty("composePath");
    expect(manifest).toHaveProperty("envPath");
    expect(manifest).toHaveProperty("apiUrl");
    expect(manifest).toHaveProperty("dashboardUrl");
  });

  test("version is 1", () => {
    const manifest = generateManifest(devState) as Record<string, unknown>;
    expect(manifest.version).toBe(1);
  });

  test("createdAt is a valid ISO date string", () => {
    const manifest = generateManifest(devState) as Record<string, unknown>;
    const date = new Date(manifest.createdAt as string);
    expect(date.toISOString()).toBe(manifest.createdAt);
  });

  // ── Dev preset services ──

  test("dev preset produces correct services array", () => {
    const manifest = generateManifest(devState) as Record<string, unknown>;
    const services = manifest.services as Array<Record<string, unknown>>;
    expect(services).toHaveLength(3);

    // Lead service
    expect(services[0].name).toBe("lead");
    expect(services[0].templateId).toBe("official/lead");
    expect(services[0].agentId).toBe("lead-uuid");
    expect(services[0].role).toBe("lead");
    expect(services[0].displayName).toBe("Lead");

    // Coder 1
    expect(services[1].name).toBe("worker-coder-1");
    expect(services[1].templateId).toBe("official/coder");
    expect(services[1].agentId).toBe("coder-uuid-1");
    expect(services[1].role).toBe("worker");
    expect(services[1].displayName).toBe("Coder 1");

    // Coder 2
    expect(services[2].name).toBe("worker-coder-2");
    expect(services[2].agentId).toBe("coder-uuid-2");
    expect(services[2].displayName).toBe("Coder 2");
  });

  // ── State values propagate ──

  test("deployType, preset, and harness match state", () => {
    const manifest = generateManifest(devState) as Record<string, unknown>;
    expect(manifest.deployType).toBe("local");
    expect(manifest.preset).toBe("dev");
    expect(manifest.harness).toBe("claude");
  });

  // ── Integration flags match state ──

  test("integration flags match state", () => {
    const manifest = generateManifest(devState) as Record<string, unknown>;
    const integrations = manifest.integrations as Record<string, boolean>;
    expect(integrations.github).toBe(true);
    expect(integrations.slack).toBe(false);
    expect(integrations.gitlab).toBe(false);
    expect(integrations.sentry).toBe(true);
  });

  test("all integrations false when none enabled", () => {
    const state = makeState({
      services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
      agentIds: { "worker-coder": "id" },
    });
    const manifest = generateManifest(state) as Record<string, unknown>;
    const integrations = manifest.integrations as Record<string, boolean>;
    expect(integrations.github).toBe(false);
    expect(integrations.slack).toBe(false);
    expect(integrations.gitlab).toBe(false);
    expect(integrations.sentry).toBe(false);
  });

  // ── Solo preset: single worker, no lead ──

  test("solo preset has one worker service with correct role", () => {
    const state = makeState({
      presetId: "solo",
      services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
      agentIds: { "worker-coder": "solo-id" },
    });
    const manifest = generateManifest(state) as Record<string, unknown>;
    const services = manifest.services as Array<Record<string, unknown>>;
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("worker-coder");
    expect(services[0].role).toBe("worker");
    expect(services[0].displayName).toBe("Coder");
  });

  // ── Static paths ──

  test("composePath and envPath are set to default values", () => {
    const manifest = generateManifest(devState) as Record<string, unknown>;
    expect(manifest.composePath).toBe("./docker-compose.yml");
    expect(manifest.envPath).toBe("./.env");
  });
});
