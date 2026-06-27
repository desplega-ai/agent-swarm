const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "$0.0123" | "—" (4 decimals, >= $1 → 2). */
export function fmtCost(usd: number | null): string {
  if (usd === null || Number.isNaN(usd)) return "—";
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/** "3m 04s" | "850ms" | "—". */
export function fmtDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${pad2(sec)}s`;
  return `${Math.floor(min / 60)}h ${pad2(min % 60)}m`;
}

/** "Jun 11 15:30" (pages put the full ISO in a title attr). */
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "4h ago" | "—". */
export function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 0) return "now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "47.1 KB". */
export function fmtBytes(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

/** "113.4k" | "—". */
export function fmtTokens(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "0.85" | "—". */
export function fmtScore(score: number | null): string {
  if (score === null || Number.isNaN(score)) return "—";
  return score.toFixed(2);
}

/** Per-1M-token price: "$0.435" | "—" (trailing zeros trimmed). */
export function fmtPerM(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  return `$${Number(v.toFixed(4))}`;
}

const ACRONYMS = new Set(["id", "url", "api", "usd", "llm", "ms", "json", "cli"]);

/** "apiSandboxId" → "API Sandbox ID"; "bootMs" → "Boot"; "cache_read" → "Cache Read". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/);
  // duration keys read better without the trailing unit ("bootMs" → "Boot")
  if (words.length > 1 && words[words.length - 1].toLowerCase() === "ms") words.pop();
  return words
    .map((w) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return lower.length > 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}
