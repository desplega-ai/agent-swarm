import { createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

let initialized = false;
let lastAuthError: string | null = null;
let connection: GoogleDriveConnection | null = null;

const WELL_KNOWN_ADC_PATHS = [
  join(
    process.env.HOME || (process.platform === "win32" ? process.env.APPDATA || "" : ""),
    process.platform === "win32"
      ? "gcloud/application_default_credentials.json"
      : ".config/gcloud/application_default_credentials.json",
  ),
];

function resolveHomeDir(): string {
  return process.env.HOME || (process.platform === "win32" ? process.env.APPDATA || "" : "");
}

function resolveGwsCredentialsPath(): string {
  return (
    process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE ||
    join(resolveHomeDir(), ".config/gws/credentials.json")
  );
}

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
  return connection !== null || resolveCredentialsJson() !== null;
}

export function resetGoogleDrive(): void {
  initialized = false;
  lastAuthError = null;
  connection = null;
}

export async function initGoogleDrive(): Promise<boolean> {
  if (initialized) return connection !== null;
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

  try {
    const verification = await verifyServiceAccountAuth(
      raw,
      process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID,
    );
    const credentialFilePath = persistGoogleDriveCredentials(raw);
    connection = {
      ok: true,
      clientEmail: result.clientEmail,
      projectId: result.projectId,
      credentialFilePath,
      sharedDriveId: process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID || undefined,
      connectedAt: new Date().toISOString(),
      tokenExpiresAt: verification.expiresAt,
    };
    lastAuthError = null;
    console.log(
      `[Google Drive] Integration connected (SA: ${result.clientEmail}, project: ${result.projectId}, credentials: ${credentialFilePath})`,
    );
    return true;
  } catch (err) {
    lastAuthError = err instanceof Error ? err.message : String(err);
    connection = null;
    console.error(
      `[Google Drive] SA credentials valid but auth failed: ${lastAuthError} (SA: ${result.clientEmail})`,
    );
    return false;
  }
}

export interface ServiceAccountInfo {
  ok: true;
  clientEmail: string;
  projectId: string;
}

export interface GoogleDriveConnection extends ServiceAccountInfo {
  credentialFilePath: string;
  sharedDriveId?: string;
  connectedAt: string;
  tokenExpiresAt: string;
}

export interface ServiceAccountError {
  ok: false;
  error: string;
}

export type ServiceAccountResult = ServiceAccountInfo | ServiceAccountError;

export interface ServiceAccountVerification {
  accessToken: string;
  expiresAt: string;
}

export function getGoogleDriveConnection(): GoogleDriveConnection | null {
  return connection;
}

/**
 * Sign a JWT with the SA's private key and exchange it at Google's token
 * endpoint, then make a lightweight Drive API request. Proves the credentials
 * can actually reach Drive — not just that the JSON is structurally valid.
 */
export async function verifyServiceAccountAuth(
  raw: string,
  sharedDriveId?: string,
): Promise<ServiceAccountVerification> {
  const sa = JSON.parse(raw) as {
    client_email: string;
    private_key: string;
    token_uri: string;
  };

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: sa.token_uri,
      iat: now,
      exp: now + 300,
    }),
  ).toString("base64url");

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(sa.private_key, "base64url");

  const jwt = `${header}.${payload}.${signature}`;

  const resp = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token endpoint returned ${resp.status}: ${body}`);
  }

  const token = (await resp.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof token.access_token !== "string" || token.access_token.length === 0) {
    throw new Error("Token endpoint response did not include access_token");
  }

  await verifyDriveApiAccess(token.access_token, sharedDriveId);

  const expiresIn =
    typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
      ? token.expires_in
      : 3600;
  return {
    accessToken: token.access_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

async function verifyDriveApiAccess(accessToken: string, sharedDriveId?: string): Promise<void> {
  const params = new URLSearchParams({
    pageSize: "1",
    fields: "files(id)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (sharedDriveId && sharedDriveId.length > 0) {
    params.set("corpora", "drive");
    params.set("driveId", sharedDriveId);
  }

  const resp = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Drive API files.list returned ${resp.status}: ${body}`);
  }
}

function persistGoogleDriveCredentials(raw: string): string {
  const credentialFilePath = resolveGwsCredentialsPath();
  mkdirSync(dirname(credentialFilePath), { recursive: true, mode: 0o700 });
  writeFileSync(credentialFilePath, raw, { encoding: "utf-8", mode: 0o600 });
  process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = credentialFilePath;
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||= credentialFilePath;
  return credentialFilePath;
}

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
