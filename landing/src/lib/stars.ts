const REPO = "desplega-ai/agent-swarm";
const STAR_FALLBACK = 239;
const VERSION_FALLBACK = "v1.50";
const REVALIDATE = 21600;
const HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "agent-swarm-www",
};

export async function getStarCount(): Promise<number> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      next: { revalidate: REVALIDATE },
      headers: HEADERS,
    });
    if (!res.ok) return STAR_FALLBACK;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number" ? data.stargazers_count : STAR_FALLBACK;
  } catch {
    return STAR_FALLBACK;
  }
}

export async function getLatestRelease(): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      next: { revalidate: REVALIDATE },
      headers: HEADERS,
    });
    if (!res.ok) return VERSION_FALLBACK;
    const data = (await res.json()) as { tag_name?: string; name?: string };
    const raw = data.tag_name || data.name;
    if (!raw || typeof raw !== "string") return VERSION_FALLBACK;
    return raw.startsWith("v") ? raw : `v${raw}`;
  } catch {
    return VERSION_FALLBACK;
  }
}
