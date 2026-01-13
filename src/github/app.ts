let initialized = false;
let webhookSecret: string | null = null;
let appId: string | null = null;
let privateKey: string | null = null;

// Token cache: installationId -> { token, expiresAt }
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

export function isGitHubEnabled(): boolean {
  // Check if GitHub is explicitly disabled
  const githubDisable = process.env.GITHUB_DISABLE;
  if (githubDisable === "true" || githubDisable === "1") {
    return false;
  }

  return !!process.env.GITHUB_WEBHOOK_SECRET;
}

export function initGitHub(): boolean {
  // Prevent double initialization
  if (initialized) {
    console.log("[GitHub] Already initialized, skipping");
    return isGitHubEnabled();
  }
  initialized = true;

  // Check if GitHub is explicitly disabled
  const githubDisable = process.env.GITHUB_DISABLE;
  if (githubDisable === "true" || githubDisable === "1") {
    console.log("[GitHub] Disabled via GITHUB_DISABLE");
    return false;
  }

  webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? null;

  if (!webhookSecret) {
    console.log("[GitHub] Missing GITHUB_WEBHOOK_SECRET, GitHub integration disabled");
    return false;
  }

  // Load App credentials for bot reactions (optional)
  appId = process.env.GITHUB_APP_ID ?? null;
  const rawPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY ?? null;

  if (appId && rawPrivateKey) {
    // Convert \n escape sequences to actual newlines
    privateKey = rawPrivateKey.replace(/\\n/g, "\n");
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
async function generateAppJWT(): Promise<string | null> {
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
  // Check cache first
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    // Still valid for at least 1 minute
    return cached.token;
  }

  const jwt = await generateAppJWT();
  if (!jwt) {
    console.log("[GitHub] No JWT available, cannot get installation token");
    return null;
  }

  try {
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
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
    tokenCache.set(installationId, { token: data.token, expiresAt });

    console.log(
      `[GitHub] Got installation token for ${installationId}, expires at ${data.expires_at}`,
    );
    return data.token;
  } catch (error) {
    console.error("[GitHub] Error getting installation token:", error);
    return null;
  }
}
