import { getSwarmRepos } from "../be/db";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { githubApiUrl, resolveGitHubHost } from "../utils/github-host";

let initialized = false;
let webhookSecret: string | null = null;
let appId: string | null = null;
let privateKey: string | null = null;

// Token cache: installationId -> { token, expiresAt }
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

// Repo -> installation cache, so a worker's every git/gh call does not cost a
// `GET /repos/{owner}/{repo}/installation`. Positive results only: an
// installation added later works without restarting the API.
const INSTALLATION_CACHE_TTL_MS = 10 * 60_000;
const installationCache = new Map<string, { id: number; expiresAt: number }>();

/** Raw PEM (with literal `\\n` escapes) or base64-encoded PEM. */
function decodePrivateKey(raw: string): string {
  return raw.startsWith("-----BEGIN")
    ? raw.replace(/\\n/g, "\n")
    : Buffer.from(raw, "base64").toString("utf-8");
}

export function isGitHubEnabled(): boolean {
  // Check if GitHub is explicitly disabled
  if (isEnvFlagEnabled("GITHUB_DISABLE", false)) {
    return false;
  }

  return !!process.env.GITHUB_WEBHOOK_SECRET;
}

export function resetGitHub(): void {
  initialized = false;
  webhookSecret = null;
  appId = null;
  privateKey = null;
  tokenCache.clear();
  installationCache.clear();
}

export function initGitHub(): boolean {
  // Prevent double initialization
  if (initialized) {
    console.log("[GitHub] Already initialized, skipping");
    return isGitHubEnabled();
  }
  initialized = true;

  // Check if GitHub is explicitly disabled
  if (isEnvFlagEnabled("GITHUB_DISABLE", false)) {
    console.log("[GitHub] Disabled via GITHUB_DISABLE");
    return false;
  }

  const host = resolveGitHubHost();
  if (!host.ok) {
    console.error(`[GitHub] ${host.error}; GitHub integration disabled`);
    return false;
  }
  if (host.warning) console.warn(`[GitHub] ${host.warning}`);
  console.log(`[GitHub] Host: web ${host.config.webUrl}, API ${host.config.apiUrl}`);

  webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? null;

  if (!webhookSecret) {
    console.log("[GitHub] Missing GITHUB_WEBHOOK_SECRET, GitHub integration disabled");
    return false;
  }

  // Load App credentials for bot reactions (optional)
  appId = process.env.GITHUB_APP_ID ?? null;
  const rawPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? null;

  if (appId && rawPrivateKey) {
    privateKey = decodePrivateKey(rawPrivateKey);
    console.log("[GitHub] App credentials loaded for bot reactions");
  } else {
    console.log("[GitHub] No App credentials, bot reactions disabled");
  }

  console.log("[GitHub] Webhook handler initialized");
  return true;
}

/**
 * Check if bot reactions are enabled (requires App credentials)
 */
export function isReactionsEnabled(): boolean {
  return !!(appId && privateKey);
}

export function getWebhookSecret(): string | null {
  return webhookSecret;
}

/**
 * Verify webhook signature using HMAC SHA-256
 * GitHub sends signature in x-hub-signature-256 header
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | null,
): Promise<boolean> {
  if (!webhookSecret || !signature) {
    console.log(
      `[GitHub] Signature verification failed: webhookSecret=${!!webhookSecret}, signature=${!!signature}`,
    );
    return false;
  }

  // Signature format: sha256=<hex>
  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const expectedSig = signature.slice(7); // Remove "sha256=" prefix

  // Use Web Crypto API for HMAC
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const computedSig = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe comparison
  if (computedSig.length !== expectedSig.length) {
    console.log(
      `[GitHub] Signature length mismatch: computed=${computedSig.length}, expected=${expectedSig.length}`,
    );
    return false;
  }

  let result = 0;
  for (let i = 0; i < computedSig.length; i++) {
    result |= computedSig.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }

  const isValid = result === 0;
  if (!isValid) {
    console.log(`[GitHub] Signature mismatch:`);
    console.log(`  Expected: ${expectedSig}`);
    console.log(`  Computed: ${computedSig}`);
  }

  return isValid;
}

/**
 * Generate a JWT for GitHub App authentication
 * JWTs are valid for up to 10 minutes
 */
async function generateAppJWT(
  creds: { appId: string | null; privateKey: string | null } = { appId, privateKey },
): Promise<string | null> {
  const { appId, privateKey } = creds;
  if (!appId || !privateKey) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // Issued 60 seconds ago (clock skew tolerance)
    exp: now + 600, // Expires in 10 minutes
    iss: appId,
  };

  // Base64url encode helper
  const base64url = (data: string | Buffer): string => {
    const base64 = Buffer.isBuffer(data)
      ? data.toString("base64")
      : Buffer.from(data).toString("base64");
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  // JWT header
  const header = { alg: "RS256", typ: "JWT" };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Sign using Node's crypto module (handles PEM keys directly)
  try {
    const crypto = await import("node:crypto");
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(signingInput);
    const signature = sign.sign(privateKey);
    const signatureB64 = base64url(signature);
    return `${signingInput}.${signatureB64}`;
  } catch (error) {
    console.error("[GitHub] Failed to generate JWT:", error);
    return null;
  }
}

/**
 * Get an installation access token for the GitHub App
 * Tokens are cached until they expire (typically 1 hour)
 */
export async function getInstallationToken(installationId: number): Promise<string | null> {
  return (
    (await mintInstallationToken(installationId, { appId, privateKey }, 60_000))?.token ?? null
  );
}

async function mintInstallationToken(
  installationId: number,
  creds: { appId: string | null; privateKey: string | null },
  minValidityMs: number,
): Promise<{ token: string; expiresAt: number } | null> {
  // Check cache first
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + minValidityMs) {
    return cached;
  }

  const jwt = await generateAppJWT(creds);
  if (!jwt) {
    console.log("[GitHub] No JWT available, cannot get installation token");
    return null;
  }

  try {
    const response = await fetch(
      githubApiUrl(`/app/installations/${installationId}/access_tokens`),
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GitHub] Failed to get installation token: ${response.status} ${errorText}`);
      return null;
    }

    const data = (await response.json()) as {
      token: string;
      expires_at: string;
    };
    const expiresAt = new Date(data.expires_at).getTime();

    // Cache the token
    const minted = { token: data.token, expiresAt };
    tokenCache.set(installationId, minted);

    console.log(
      `[GitHub] Got installation token for ${installationId}, expires at ${data.expires_at}`,
    );
    return minted;
  } catch (error) {
    console.error("[GitHub] Error getting installation token:", error);
    return null;
  }
}

export type WorkerInstallationToken =
  | { status: "ok"; token: string; expiresAt: string }
  | { status: "unconfigured" }
  | { status: "forbidden" }
  | { status: "error" };

/**
 * `owner/name`, lowercased, from a swarm repo URL (`https://github.com/o/r.git`),
 * an scp-like remote (`git@host:o/r`) or the shorthand itself. GitHub treats
 * owner and repo names case-insensitively, so the `swarm_repos` comparison does
 * too; the last two path segments are the identity, whichever form the caller got.
 * A `.`/`..` segment returns `""`, which matches no registered repo, so a caller
 * cannot aim the installation lookup at another API path.
 */
export function normalizeRepo(repo: string): string {
  const trimmed = repo.trim().replace(/\/+$/, "");
  const lastTwo = trimmed.replace(/\.git$/i, "").match(/([^/:]+\/[^/:]+)$/);
  if (!lastTwo) return trimmed.toLowerCase();
  const [owner, name] = lastTwo[1]!.split("/") as [string, string];
  if (owner === "." || owner === ".." || name === "." || name === "..") return "";
  return lastTwo[1]!.toLowerCase();
}

/**
 * Owners (GitHub user or org logins, lowercased) whose repos may get a token for
 * their own installation, from the deployment env `GITHUB_APP_REPO_OWNERS`
 * (comma-separated). It is a reserved key, so no config writer can extend it.
 * Empty: every call mints for `GITHUB_APP_INSTALLATION_ID`, as before.
 */
function allowedRepoOwners(): Set<string> {
  return new Set(
    (process.env.GITHUB_APP_REPO_OWNERS ?? "")
      .split(",")
      .map((owner) => owner.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * `owner/name` of a `swarm_repos` URL when it points at the configured GitHub
 * host (https, ssh or scp-like) or is the bare `owner/name` shorthand; `null`
 * for any other host or shape. A URL on another host whose path merely ends in
 * `owner/name` is not that repository.
 */
function registeredSlugOnHost(url: string, host: string): string | null {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  let urlHost: string | null = null;
  let path: string;
  const scp = trimmed.match(/^[^@/:]+@([^:/]+):(.+)$/);
  if (scp) {
    urlHost = scp[1]!.toLowerCase();
    path = scp[2]!;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      urlHost = parsed.host.toLowerCase();
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else {
    path = trimmed;
  }
  if (
    urlHost !== null &&
    urlHost !== host &&
    !(host === "github.com" && urlHost === "www.github.com")
  ) {
    return null;
  }
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.length !== 2) return null;
  const slug = normalizeRepo(segments.join("/"));
  return slug || null;
}

/**
 * The App installation that owns `repo`, asked of GitHub with an App JWT
 * (`GET /repos/{owner}/{repo}/installation`). Cached for ten minutes because a
 * worker asks once per git/gh call. `null` when GitHub does not answer 200:
 * no installation, a revoked one, or an App that cannot see the repository.
 * Also `null` when the installation's account is not an allowed owner (a
 * transferred repo redirects to its new owner's installation).
 */
async function resolveInstallationId(
  repo: string,
  creds: { appId: string | null; privateKey: string | null },
  owners: Set<string>,
): Promise<number | null> {
  const cached = installationCache.get(repo);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  const jwt = await generateAppJWT(creds);
  if (!jwt) return null;

  try {
    const response = await fetch(githubApiUrl(`/repos/${repo}/installation`), {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (response.status !== 200) {
      console.log(`[GitHub] No installation for ${repo}: ${response.status}`);
      return null;
    }
    const data = (await response.json()) as { id?: unknown; account?: { login?: unknown } };
    if (typeof data.id !== "number") return null;
    const account = typeof data.account?.login === "string" ? data.account.login.toLowerCase() : "";
    if (!owners.has(account)) {
      console.log(`[GitHub] Installation for ${repo} belongs to an owner that is not allowed`);
      return null;
    }
    installationCache.set(repo, {
      id: data.id,
      expiresAt: Date.now() + INSTALLATION_CACHE_TTL_MS,
    });
    return data.id;
  } catch (error) {
    console.error("[GitHub] Error resolving the repo installation:", error);
    return null;
  }
}

/**
 * Installation token for worker `git` / `gh`.
 *
 * With a `repo` (`owner/name`) whose owner is listed in the deployment env
 * `GITHUB_APP_REPO_OWNERS`, the token is minted for that repository's App
 * installation, resolved with the App JWT: one App with an installation per
 * owner can then serve repos from more than one account. The operator's owner
 * list is the boundary; the repository must also be registered in `swarm_repos`
 * on the configured GitHub host.
 *
 * Any other call, with no repo or a repo of an unlisted owner, mints for the
 * fixed `GITHUB_APP_INSTALLATION_ID`, so a single-installation deployment
 * behaves exactly as before and a caller never picks an installation the
 * operator did not list.
 *
 * Reads env on each call: it works without the webhook (`initGitHub` loads App
 * credentials only when `GITHUB_WEBHOOK_SECRET` is set).
 */
export async function getWorkerInstallationToken(repo?: string): Promise<WorkerInstallationToken> {
  if (isEnvFlagEnabled("GITHUB_DISABLE", false)) return { status: "unconfigured" };
  const workerAppId = process.env.GITHUB_APP_ID?.trim();
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!workerAppId || !rawKey) return { status: "unconfigured" };
  const host = resolveGitHubHost();
  if (!host.ok) return { status: "error" };
  const creds = { appId: workerAppId, privateKey: decodePrivateKey(rawKey) };

  const owners = allowedRepoOwners();
  const target = repo ? normalizeRepo(repo) : "";
  const owner = target.split("/")[0] ?? "";
  let installationId: number;
  if (target && owners.has(owner)) {
    // An allowed owner: the repo must also be one the swarm manages on this host.
    const registered = (await getSwarmRepos()).some(
      (r) => registeredSlugOnHost(r.url, host.config.host) === target,
    );
    if (!registered) return { status: "forbidden" };
    const resolved = await resolveInstallationId(target, creds, owners);
    if (resolved === null) return { status: "error" };
    installationId = resolved;
  } else {
    const rawInstallation = process.env.GITHUB_APP_INSTALLATION_ID?.trim() ?? "";
    if (!/^[1-9][0-9]{0,15}$/.test(rawInstallation)) return { status: "unconfigured" };
    installationId = Number(rawInstallation);
  }

  // Hand out a token with at least 10 minutes left, so a worker can cache it.
  const minted = await mintInstallationToken(installationId, creds, 10 * 60_000);
  if (!minted) return { status: "error" };
  return { status: "ok", token: minted.token, expiresAt: new Date(minted.expiresAt).toISOString() };
}
