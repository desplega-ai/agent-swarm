/**
 * Azure Repos URL helpers. Pure functions, safe on both the API server and
 * the worker (no DB imports).
 */

export function isAzureDevOpsUrl(url: string): boolean {
  return /(^|[/@.])dev\.azure\.com[/:]|\.visualstudio\.com[/:]/i.test(url);
}

/**
 * Canonical repo identifier for an Azure Repos remote: an HTTPS clone URL
 * with no `user@` prefix, no trailing `/` or `.git`, and the project segment
 * spelled out, e.g. `https://dev.azure.com/org/project/_git/repo`.
 * Webhook tasks store it as `vcsRepo`, and a worker can `git clone` it as-is.
 * Returns the trimmed input when it is not a recognisable Azure Repos URL.
 */
export function canonicalAzureDevOpsRepoUrl(url: string): string {
  const trimmed = url.trim();
  // SSH: git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  const ssh = trimmed.match(
    /^(?:ssh:\/\/)?[^@]+@ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (ssh) return `https://dev.azure.com/${ssh[1]}/${ssh[2]}/_git/${ssh[3]}`;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const parts = parsed.pathname
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter(Boolean);
  // Short form https://dev.azure.com/{org}/_git/{repo} addresses the project named like the repo.
  if (parsed.hostname === "dev.azure.com" && parts.length === 3 && parts[1] === "_git") {
    parts.splice(1, 0, parts[2] as string);
  }
  parsed.pathname = `/${parts.join("/")}`;
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * Split an Azure Repos URL into the pieces `az repos` and the REST API take.
 * Returns null when the URL has no `/_git/{repo}` segment.
 */
export function parseAzureDevOpsRepoUrl(
  url: string,
): { orgUrl: string; project: string; repository: string } | null {
  const canonical = canonicalAzureDevOpsRepoUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(canonical);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const gitIndex = parts.indexOf("_git");
  const repository = parts[gitIndex + 1];
  if (gitIndex < 1 || !repository) {
    // Legacy {org}.visualstudio.com/_git/{repo}: project named like the repo.
    if (gitIndex === 0 && repository) {
      return { orgUrl: parsed.origin, project: repository, repository };
    }
    return null;
  }
  // Legacy collection URLs (…/DefaultCollection/_git/{repo}) also omit the project.
  const collectionOnly = parts[gitIndex - 1]?.toLowerCase() === "defaultcollection";
  const project = collectionOnly ? repository : (parts[gitIndex - 1] as string);
  const orgPath = parts.slice(0, collectionOnly ? gitIndex : gitIndex - 1).join("/");
  return {
    orgUrl: orgPath ? `${parsed.origin}/${orgPath}` : parsed.origin,
    project: decodeURIComponent(project),
    repository: decodeURIComponent(repository),
  };
}
