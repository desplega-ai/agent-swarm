import { randomUUID } from "node:crypto";
import { getSwarmConfigs, upsertSwarmConfig } from "./be/db";

export interface InstallationIdentity {
  installId: string | null;
  installedAt: string | null;
}

async function readGlobalConfig(key: string): Promise<string | null> {
  const rows = await getSwarmConfigs({ scope: "global", key });
  return rows[0]?.value || null;
}

export async function readInstallationIdentity(): Promise<InstallationIdentity> {
  const [installId, installedAt] = await Promise.all([
    readGlobalConfig("telemetry_installation_id"),
    readGlobalConfig("telemetry_installed_at"),
  ]);
  return { installId, installedAt };
}

/**
 * Feedback uses the telemetry installation identity for correlation, but is
 * independent of anonymous telemetry consent. A send may therefore mint the
 * durable ID when telemetry is disabled; it never emits an analytics event.
 * It deliberately does not mint an install-date anchor at submission time,
 * because that would turn an unknown installation age into a false fresh one.
 */
export async function ensureInstallationIdentity(): Promise<{
  installId: string;
  installedAt: string | null;
}> {
  const current = await readInstallationIdentity();
  if (current.installId) return { installId: current.installId, installedAt: current.installedAt };

  await upsertSwarmConfig({
    scope: "global",
    key: "telemetry_installation_id",
    value: `install_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  });
  const created = await readInstallationIdentity();
  if (!created.installId) throw new Error("Failed to persist installation identity");
  return { installId: created.installId, installedAt: created.installedAt };
}
