import { githubApiUrl, isGitHubEnterprise } from "../utils/github-host";
import { getCurrentRequestAuth } from "../utils/request-auth-context";
import { getWorkerInstallationToken } from "./app";

export type RemoteSkillFile =
  | { ok: true; content: string; sourceUrl: string }
  | { ok: false; status: number; error: string; sourceUrl: string };

const NAME = /^[A-Za-z0-9_.-]+$/;
// Branch and path segments may hold any character: each one is URL-encoded, so only the dot
// and empty segments a URL resolver would collapse are refused.
const REF_SEGMENT = /^[\s\S]+$/;

/** Split on `/`; null when any segment is empty, `.`, `..` or fails `allowed`. */
function segmentsOf(value: string, allowed: RegExp): string[] | null {
  const parts = value.split("/");
  return parts.every((p) => p !== "." && p !== ".." && allowed.test(p)) ? parts : null;
}

const encodePath = (parts: string[]) => parts.map(encodeURIComponent).join("/");

/**
 * Fetch `<sourcePath>/SKILL.md` from a GitHub repo. With a server-side token (the App
 * installation token, else `GITHUB_TOKEN`) it reads through the contents API, so private
 * repos work; without one, or when the token read fails, it reads unauthenticated (raw
 * content on github.com, the contents API on Enterprise). The token travels only in the
 * Authorization header: `sourceUrl` and `error` never carry it.
 */
export async function fetchRemoteSkillFile(
  sourceRepo: string,
  branch: string,
  sourcePath?: string | null,
): Promise<RemoteSkillFile> {
  // Every segment reaches a URL, and the API URL carries the token: a dot segment would
  // resolve to another endpoint (`../orgs` leaves /repos/), so each one is checked and encoded.
  const repo = segmentsOf(sourceRepo, NAME);
  const ref = segmentsOf(branch, REF_SEGMENT);
  const path = segmentsOf(sourcePath ? `${sourcePath}/SKILL.md` : "SKILL.md", REF_SEGMENT);
  if (repo?.length !== 2 || !ref || !path) {
    return {
      ok: false,
      status: 400,
      error: "invalid sourceRepo, branch or sourcePath",
      sourceUrl: "",
    };
  }
  const sourceUrl = `https://raw.githubusercontent.com/${encodePath(repo)}/${encodePath(ref)}/${encodePath(path)}`;
  const apiUrl = githubApiUrl(
    `/repos/${encodePath(repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
  );
  const read = (url: string, token?: string) =>
    fetch(url, {
      headers: {
        Accept: "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

  // ACP task tokens never get server-held credentials (see /api/github/installation-token).
  const caller = getCurrentRequestAuth();
  const taskToken = caller?.kind === "agent" && caller.tokenKind === "task";
  const auth = taskToken ? null : await getWorkerInstallationToken();
  const token = taskToken
    ? undefined
    : auth?.status === "ok"
      ? auth.token
      : process.env.GITHUB_TOKEN?.trim();
  let authStatus: number | undefined;
  if (token) {
    const res = await read(apiUrl, token);
    if (res.ok) return { ok: true, content: await res.text(), sourceUrl };
    authStatus = res.status;
  }
  // Public repos still install when the token cannot see them (another org, revoked).
  const res = await read(isGitHubEnterprise() ? apiUrl : sourceUrl);
  if (res.ok) return { ok: true, content: await res.text(), sourceUrl };

  if (authStatus === 401 || authStatus === 403) {
    return {
      ok: false,
      status: authStatus,
      error: `GitHub refused the configured token (HTTP ${authStatus}) for ${sourceRepo}`,
      sourceUrl,
    };
  }
  if (res.status === 404) {
    const hint = token
      ? "if the repo is private, the configured GitHub token cannot read it"
      : "if the repo is private, configure a GitHub token on the API server";
    return { ok: false, status: 404, error: `SKILL.md not found (HTTP 404); ${hint}`, sourceUrl };
  }
  return { ok: false, status: res.status, error: `HTTP ${res.status}`, sourceUrl };
}
