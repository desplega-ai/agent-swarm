import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGoogleDriveConnection, initGoogleDrive, resetGoogleDrive } from "../google-drive";

const originalFetch = globalThis.fetch;
const savedEnv = {
  GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  GOOGLE_DRIVE_DISABLE: process.env.GOOGLE_DRIVE_DISABLE,
  GOOGLE_DRIVE_SA_CREDENTIALS: process.env.GOOGLE_DRIVE_SA_CREDENTIALS,
  GOOGLE_DRIVE_SHARED_DRIVE_ID: process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID,
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE,
  HOME: process.env.HOME,
};

function makeServiceAccountJson(tokenUri = "https://oauth2.googleapis.test/token"): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  return JSON.stringify({
    type: "service_account",
    project_id: "drive-project",
    private_key: privateKey,
    client_email: "drive-sa@example.iam.gserviceaccount.com",
    token_uri: tokenUri,
  });
}

describe("Google Drive init", () => {
  let homeDir: string;

  beforeEach(() => {
    resetGoogleDrive();
    homeDir = mkdtempSync(join(tmpdir(), "swarm-google-drive-"));
    process.env.HOME = homeDir;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_DRIVE_DISABLE;
    delete process.env.GOOGLE_DRIVE_SA_CREDENTIALS;
    delete process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID;
    delete process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  });

  afterEach(() => {
    resetGoogleDrive();
    globalThis.fetch = originalFetch;
    rmSync(homeDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("authenticates, probes Drive, and persists credentials for gws", async () => {
    const tokenUri = "https://oauth2.googleapis.test/token";
    const raw = makeServiceAccountJson(tokenUri);
    process.env.GOOGLE_DRIVE_SA_CREDENTIALS = raw;
    process.env.GOOGLE_DRIVE_SHARED_DRIVE_ID = "shared-drive-123";

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });

      if (url === tokenUri) {
        return new Response(JSON.stringify({ access_token: "ya29.test-token", expires_in: 120 }), {
          status: 200,
        });
      }

      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }

      return new Response("unexpected url", { status: 500 });
    }) as typeof fetch;

    await expect(initGoogleDrive()).resolves.toBe(true);

    const credentialFilePath = join(homeDir, ".config/gws/credentials.json");
    expect(existsSync(credentialFilePath)).toBe(true);
    expect(readFileSync(credentialFilePath, "utf-8")).toBe(raw);
    expect(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBe(credentialFilePath);
    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(credentialFilePath);

    const connection = getGoogleDriveConnection();
    expect(connection).toMatchObject({
      clientEmail: "drive-sa@example.iam.gserviceaccount.com",
      projectId: "drive-project",
      credentialFilePath,
      sharedDriveId: "shared-drive-123",
    });

    expect(calls.map((c) => c.url)).toHaveLength(2);
    expect(calls[0].url).toBe(tokenUri);
    const driveUrl = new URL(calls[1].url);
    expect(driveUrl.hostname).toBe("www.googleapis.com");
    expect(driveUrl.pathname).toBe("/drive/v3/files");
    expect(driveUrl.searchParams.get("pageSize")).toBe("1");
    expect(driveUrl.searchParams.get("fields")).toBe("files(id)");
    expect(driveUrl.searchParams.get("corpora")).toBe("drive");
    expect(driveUrl.searchParams.get("driveId")).toBe("shared-drive-123");
    expect(calls[1].init?.headers).toEqual({ Authorization: "Bearer ya29.test-token" });
  });

  test("does not connect or persist credentials when the Drive API probe fails", async () => {
    const tokenUri = "https://oauth2.googleapis.test/token";
    process.env.GOOGLE_DRIVE_SA_CREDENTIALS = makeServiceAccountJson(tokenUri);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === tokenUri) {
        return new Response(JSON.stringify({ access_token: "ya29.test-token", expires_in: 120 }), {
          status: 200,
        });
      }
      return new Response("drive api disabled", { status: 403 });
    }) as typeof fetch;

    await expect(initGoogleDrive()).resolves.toBe(false);
    expect(getGoogleDriveConnection()).toBeNull();
    expect(existsSync(join(homeDir, ".config/gws/credentials.json"))).toBe(false);
  });
});
