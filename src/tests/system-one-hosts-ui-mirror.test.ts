import { describe, expect, test } from "bun:test";
import {
  SYSTEM_ONE_DECIDE_DEFAULT_KEY,
  SYSTEM_ONE_EXTRACT_DEFAULT_KEY,
  SYSTEM_ONE_FALLBACK,
  SYSTEM_ONE_HOST_VIEWS,
} from "../../apps/ui/src/lib/system-one-hosts";
import {
  SYSTEM_ONE_DEFAULT_PROVIDER,
  SYSTEM_ONE_DEFAULT_PROVIDER_CONFIG_KEY,
  SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER,
  SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER_CONFIG_KEY,
  SYSTEM_ONE_HOSTS,
  type SystemOneHost,
} from "../workflows/executors/system-one-providers";

type Service = SystemOneHost["decide"] | SystemOneHost["extract"];

/** What the dashboard mirrors of one service. */
function serviceShape(service: Service) {
  if (!service) return undefined;
  return {
    defaultModel: service.defaultModel,
    allowedModels: service.allowedModels ? [...service.allowedModels] : undefined,
  };
}

function configKeyOf(host: SystemOneHost): string | undefined {
  const endpoint = (host.decide ?? host.extract)?.endpoint;
  return endpoint && typeof endpoint !== "string" ? endpoint.configKey : undefined;
}

// The dashboard never imports `src/`: `apps/ui/src/lib/system-one-hosts.ts`
// mirrors `SYSTEM_ONE_HOSTS` for Connect › AI providers › System One.
describe("System One hosts: the dashboard mirror", () => {
  test("lists the same hosts with the same keys, capabilities and models", () => {
    const server = Object.entries(SYSTEM_ONE_HOSTS as Record<string, SystemOneHost>).map(
      ([id, host]) => ({
        id,
        keyName: host.keyName,
        fallbackKeyNames: host.fallbackKeyNames ? [...host.fallbackKeyNames] : undefined,
        configKey: configKeyOf(host),
        decide: serviceShape(host.decide),
        extract: serviceShape(host.extract),
      }),
    );
    const ui = SYSTEM_ONE_HOST_VIEWS.map((host) => ({
      id: host.id,
      keyName: host.keyName,
      fallbackKeyNames: host.fallbackKeyNames ? [...host.fallbackKeyNames] : undefined,
      configKey: host.configKey,
      decide: serviceShape(host.decide as Service),
      extract: serviceShape(host.extract as Service),
    }));
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(ui.sort(byId)).toEqual(server.sort(byId));
  });

  test("names the same default keys and fallbacks", () => {
    expect(SYSTEM_ONE_DECIDE_DEFAULT_KEY).toBe(SYSTEM_ONE_DEFAULT_PROVIDER_CONFIG_KEY);
    expect(SYSTEM_ONE_EXTRACT_DEFAULT_KEY).toBe(SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER_CONFIG_KEY);
    expect(SYSTEM_ONE_FALLBACK).toEqual({
      decide: SYSTEM_ONE_DEFAULT_PROVIDER,
      extract: SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER,
    });
  });
});
