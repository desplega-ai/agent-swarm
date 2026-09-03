/**
 * Shared helpers for the agent-fs version pins this repo carries.
 *
 * Used by:
 *   - scripts/bump-agent-fs.ts       rewrites every pin to a target version
 *   - scripts/sync-chart-version.ts  CI gate: chart tag must equal the latest GHCR tag
 */

export const AGENT_FS_REPO = "desplega-ai/agent-fs";
export const AGENT_FS_IMAGE = "desplega-ai/agent-fs";
export const AGENT_FS_NPM_PACKAGE = "@desplega.ai/agent-fs";
/** Path inside the agent-fs repo that `npx skills add ... --skill agent-fs` resolves. */
export const AGENT_FS_SKILL_PATH = "skills/agent-fs/SKILL.md";

const GHCR_TOKEN_URL = `https://ghcr.io/token?scope=${encodeURIComponent(`repository:${AGENT_FS_IMAGE}:pull`)}&service=ghcr.io`;
const GHCR_TAGS_URL = `https://ghcr.io/v2/${AGENT_FS_IMAGE}/tags/list?n=1000`;
const OCI_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * Matches the `tag:` line under an `agentFs:` -> `image:` YAML block.
 * Group 1 is everything up to the tag value, group 2 is the tag itself, so
 * `replace(pattern, "$1<version>")` rewrites the pin and keeps quoting intact.
 */
export const AGENT_FS_HELM_TAG_PATTERN =
  /(^agentFs:\s*$[\s\S]*?^ {2}image:\s*$[\s\S]*?^ {4}tag:\s*["']?)([^\s"']+)/m;

export function stableVersionParts(value: string): [number, number, number] | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareStableVersions(left: string, right: string): number {
  const a = stableVersionParts(left);
  const b = stableVersionParts(right);
  if (!a || !b) throw new Error(`Cannot compare non-stable image tags: ${left}, ${right}`);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function fetchWithRetry(input: string, init: RequestInit = {}): Promise<Response> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Request failed after ${maxAttempts} attempts: ${input}`, {
          cause: error,
        });
      }
    }
  }
  throw new Error(`Request exhausted retries: ${input}`);
}

async function ghcrAuthHeaders(): Promise<Record<string, string>> {
  const tokenResponse = await fetchWithRetry(GHCR_TOKEN_URL);
  if (!tokenResponse.ok) {
    throw new Error(`GHCR token request failed with HTTP ${tokenResponse.status}`);
  }
  const tokenPayload = (await tokenResponse.json()) as { token?: unknown };
  if (typeof tokenPayload.token !== "string" || tokenPayload.token.length === 0) {
    throw new Error("GHCR token response did not include a token");
  }
  return { Authorization: `Bearer ${tokenPayload.token}` };
}

/** HEADs the GHCR manifest for `tag` and returns the HTTP status (200 = image exists). */
export async function checkAgentFsImageManifest(
  tag: string,
  headers?: Record<string, string>,
): Promise<number> {
  const authHeaders = headers ?? (await ghcrAuthHeaders());
  const manifestResponse = await fetchWithRetry(
    `https://ghcr.io/v2/${AGENT_FS_IMAGE}/manifests/${tag}`,
    {
      method: "HEAD",
      headers: { ...authHeaders, Accept: OCI_ACCEPT },
    },
  );
  return manifestResponse.status;
}

/** Newest stable semver tag on GHCR, verified to have a live manifest. */
export async function resolveLatestAgentFsImage(): Promise<{
  tag: string;
  manifestStatus: number;
}> {
  const headers = await ghcrAuthHeaders();
  const tagsResponse = await fetchWithRetry(GHCR_TAGS_URL, { headers });
  if (!tagsResponse.ok) {
    throw new Error(`GHCR tag-list request failed with HTTP ${tagsResponse.status}`);
  }
  const tagsPayload = (await tagsResponse.json()) as { tags?: unknown };
  const tags = Array.isArray(tagsPayload.tags)
    ? tagsPayload.tags.filter(
        (tag): tag is string => typeof tag === "string" && stableVersionParts(tag) !== undefined,
      )
    : [];
  const tag = tags.sort(compareStableVersions).at(-1);
  if (!tag) throw new Error(`GHCR returned no stable semver tags for ${AGENT_FS_IMAGE}`);

  const manifestStatus = await checkAgentFsImageManifest(tag, headers);
  if (manifestStatus !== 200) {
    throw new Error(
      `GHCR manifest check for ${AGENT_FS_IMAGE}:${tag} returned HTTP ${manifestStatus}`,
    );
  }
  return { tag, manifestStatus };
}

export function readAgentFsImageTag(valuesYaml: string, source: string): string {
  const tag = valuesYaml.match(AGENT_FS_HELM_TAG_PATTERN)?.[2];
  if (!tag) throw new Error(`${source} is missing agentFs.image.tag`);
  return tag;
}
