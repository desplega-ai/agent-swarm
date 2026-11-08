// The agent-fs label of a key the dashboard mints for this browser, so the
// person can tell their keys apart in agent-fs: `Swarm dashboard · Chrome on
// macOS · 2026-11-04`.

/** The parts of `navigator` the label reads. */
export interface BrowserHint {
  userAgent?: string;
  userAgentData?: { brands?: { brand: string }[]; platform?: string } | null;
}

const BRAND_NAMES: Record<string, string> = {
  "Google Chrome": "Chrome",
  "Microsoft Edge": "Edge",
  Opera: "Opera",
  Brave: "Brave",
  Vivaldi: "Vivaldi",
};

function browserFromUa(ua: string): string | null {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "Safari";
  return null;
}

function platformFromUa(ua: string): string | null {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

function browserName(hint: BrowserHint): string | null {
  for (const { brand } of hint.userAgentData?.brands ?? []) {
    const name = BRAND_NAMES[brand];
    if (name) return name;
  }
  return browserFromUa(hint.userAgent ?? "");
}

function platformName(hint: BrowserHint): string | null {
  const platform = hint.userAgentData?.platform;
  if (platform) return platform;
  return platformFromUa(hint.userAgent ?? "");
}

function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `Swarm dashboard · <browser> on <platform> · <YYYY-MM-DD>`, 100 characters at most. */
export function browserKeyLabel(
  hint: BrowserHint = typeof navigator === "undefined" ? {} : (navigator as BrowserHint),
  now: Date = new Date(),
): string {
  const browser = browserName(hint);
  const platform = platformName(hint);
  const client =
    browser && platform ? `${browser} on ${platform}` : (browser ?? platform ?? "Browser");
  return ["Swarm dashboard", client, localDate(now)].join(" · ").slice(0, 100);
}
