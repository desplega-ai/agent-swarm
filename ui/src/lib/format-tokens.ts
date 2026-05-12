// Format token counts in compact human-readable form: "1.2K", "3.4M".
// Used by tasks/[id] cost panel and session-log-viewer compaction stats.

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
