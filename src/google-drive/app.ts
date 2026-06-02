let initialized = false;

export function isGoogleDriveEnabled(): boolean {
  const disabled = process.env.GOOGLE_DRIVE_DISABLE;
  if (disabled === "true" || disabled === "1") return false;
  return !!process.env.GOOGLE_DRIVE_SA_CREDENTIALS;
}

export function resetGoogleDrive(): void {
  initialized = false;
}

export function initGoogleDrive(): boolean {
  if (initialized) return isGoogleDriveEnabled();
  initialized = true;

  if (!isGoogleDriveEnabled()) {
    console.log("[Google Drive] Integration disabled or GOOGLE_DRIVE_SA_CREDENTIALS not set");
    return false;
  }

  const raw = process.env.GOOGLE_DRIVE_SA_CREDENTIALS!;
  const result = parseServiceAccountJson(raw);
  if (!result.ok) {
    console.error(`[Google Drive] Invalid SA credentials: ${result.error}`);
    return false;
  }

  console.log(`[Google Drive] Integration initialized (SA: ${result.clientEmail})`);
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
