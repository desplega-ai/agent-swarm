/**
 * Carries the Codex OAuth refresh chain from one nightly run to the next.
 *
 * The Codex CLI rotates its refresh token on every refresh, and OpenAI rejects a reused one.
 * The seeded CODEX_OAUTH secret therefore survives exactly one refresh. The harness keeps the
 * rotated auth.json in a file sealed with AES-GCM under a key derived from CODEX_OAUTH. The
 * Actions cache that carries the file is readable by fork PRs, which never see the secret, so
 * the cache never holds a usable token. Reseeding the secret changes the key, so the old file
 * stops opening and the new seed starts a fresh chain.
 */
const KEY_LABEL = "agent-swarm-e2e-codex-auth-v1";

type CodexAuthJson = {
  tokens?: { access_token?: unknown; refresh_token?: unknown };
};

async function deriveKey(seed: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${KEY_LABEL}\0${seed}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function parseAuth(authJson: string): CodexAuthJson | undefined {
  try {
    const parsed = JSON.parse(authJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CodexAuthJson) : undefined;
  } catch {
    return undefined;
  }
}

function refreshTokenOf(authJson: string): string | undefined {
  const token = parseAuth(authJson)?.tokens?.refresh_token;
  return typeof token === "string" && token ? token : undefined;
}

/** Both tokens present. A blanked refresh token must never replace a working chain. */
export function usableCodexAuth(authJson: string): boolean {
  const tokens = parseAuth(authJson)?.tokens;
  return (
    typeof tokens?.access_token === "string" &&
    tokens.access_token.length > 0 &&
    refreshTokenOf(authJson) !== undefined
  );
}

export async function sealCodexAuth(authJson: string, seed: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await deriveKey(seed),
    new TextEncoder().encode(authJson),
  );
  return JSON.stringify({
    v: 1,
    iv: Buffer.from(iv).toString("base64"),
    data: Buffer.from(data).toString("base64"),
  });
}

/** The sealed auth.json, or undefined when it is malformed, tampered, or sealed under another seed. */
export async function openCodexAuth(sealed: string, seed: string): Promise<string | undefined> {
  try {
    const box = JSON.parse(sealed) as { v?: unknown; iv?: unknown; data?: unknown };
    if (box.v !== 1 || typeof box.iv !== "string" || typeof box.data !== "string") return undefined;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(box.iv, "base64") },
      await deriveKey(seed),
      Buffer.from(box.data, "base64"),
    );
    const authJson = new TextDecoder().decode(plain);
    return usableCodexAuth(authJson) ? authJson : undefined;
  } catch {
    return undefined;
  }
}

/** The persisted chain at `statePath`, if one exists for this seed. */
export async function loadCodexAuthChain(
  statePath: string | undefined,
  seed: string | undefined,
): Promise<string | undefined> {
  if (!statePath || !seed) return undefined;
  const sealed = await Bun.file(statePath)
    .text()
    .catch(() => undefined);
  return sealed ? openCodexAuth(sealed, seed) : undefined;
}

/**
 * Seals the auth.json the CLI left behind into `statePath`. Returns whether the refresh token
 * rotated against `before`, so the run log shows that the chain moved without printing a token.
 */
export async function saveCodexAuthChain(
  statePath: string | undefined,
  seed: string | undefined,
  authPath: string,
  before: string,
): Promise<"rotated" | "unchanged" | "skipped"> {
  if (!statePath || !seed) return "skipped";
  const after = await Bun.file(authPath)
    .text()
    .catch(() => undefined);
  if (!after || !usableCodexAuth(after)) return "skipped";
  await Bun.write(statePath, await sealCodexAuth(after, seed));
  await Bun.$`chmod 600 ${statePath}`.quiet();
  return refreshTokenOf(after) === refreshTokenOf(before) ? "unchanged" : "rotated";
}
