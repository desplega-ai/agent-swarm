import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let initialized = false;

const WELL_KNOWN_ADC_PATHS = [
  join(
    process.env.HOME || (process.platform === "win32" ? process.env.APPDATA || "" : ""),
    process.platform === "win32"
      ? "gcloud/application_default_credentials.json"
      : ".config/gcloud/application_default_credentials.json",
  ),
];

function resolveCredentialsJson(): string | null {
  if (process.env.GOOGLE_DRIVE_SA_CREDENTIALS) {
    return process.env.GOOGLE_DRIVE_SA_CREDENTIALS;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      return readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf-8");
    } catch {
      return null;
    }
  }

  for (const p of WELL_KNOWN_ADC_PATHS) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {}
    }
  }

  return null;
}

export function isGoogleDriveEnabled(): boolean {
  const disabled = process.env.GOOGLE_DRIVE_DISABLE;
  if (disabled === "true" || disabled === "1") return false;
  return resolveCredentialsJson() !== null;
}

export function resetGoogleDrive(): void {
  initialized = false;
}

export function initGoogleDrive(): boolean {
  if (initialized) return isGoogleDriveEnabled();
  initialized = true;

  const disabled = process.env.GOOGLE_DRIVE_DISABLE;
  if (disabled === "true" || disabled === "1") {
    console.log("[Google Drive] Integration disabled via GOOGLE_DRIVE_DISABLE");
    return false;
  }

  const raw = resolveCredentialsJson();
  if (!raw) {
    console.log(
      "[Google Drive] No credentials found (checked GOOGLE_DRIVE_SA_CREDENTIALS, GOOGLE_APPLICATION_CREDENTIALS, and well-known ADC paths)",
    );
    return false;
  }

  const result = parseServiceAccountJson(raw);
  if (!result.ok) {
    console.error(`[Google Drive] Invalid SA credentials: ${result.error}`);
    return false;
  }

  console.log(
    `[Google Drive] Integration initialized (SA: ${result.clientEmail}, project: ${result.projectId})`,
  );
  return true;
}

export interface ServiceAccountInfo {
  ok: true;
  clientEmail: string;
  projectId: string;
}

export interface ServiceAccountError {
  ok: false;
  error: string;
}

export type ServiceAccountResult = ServiceAccountInfo | ServiceAccountError;

export function parseServiceAccountJson(raw: string): ServiceAccountResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Expected a JSON object" };
  }

  if (parsed.type !== "service_account") {
    return {
      ok: false,
      error: `Expected "type": "service_account", got "${String(parsed.type)}"`,
    };
  }

  const requiredFields = ["project_id", "client_email", "private_key", "token_uri"] as const;
  for (const field of requiredFields) {
    if (typeof parsed[field] !== "string" || (parsed[field] as string).length === 0) {
      return { ok: false, error: `Missing or empty field: "${field}"` };
    }
  }

  return {
    ok: true,
    clientEmail: parsed.client_email as string,
    projectId: parsed.project_id as string,
  };
}
