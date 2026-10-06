/**
 * Small in-memory per-IP token bucket for unauthenticated routes. State is
 * per process and resets on restart, which is fine for defense-in-depth on
 * routes whose credential is already unguessable.
 */

import type { IncomingMessage } from "node:http";

/** Bucket count that triggers a prune of idle buckets. */
const PRUNE_THRESHOLD = 10_000;
/** Minimum time between prunes, so a flood of new IPs cannot force a scan per request. */
const PRUNE_INTERVAL_MS = 60_000;

/** Loopback, RFC1918, link-local and IPv6 unique-local addresses (IPv4-mapped forms included). */
function isPrivateAddress(address: string): boolean {
  const ip = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (ip === "::1" || ip.startsWith("127.") || ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.") || ip.startsWith("169.254.")) return true;
  const match = /^172\.(\d+)\./.exec(ip);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  const lower = ip.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

/**
 * Client IP for rate limiting. The rightmost `X-Forwarded-For` hop (the
 * address the nearest proxy saw) is trusted only when the socket peer is a
 * private address, i.e. a reverse proxy on the same host or network. A client
 * that reaches the API directly is keyed on its socket address, so a spoofed
 * header cannot buy it a fresh bucket.
 */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  if (!isPrivateAddress(peer)) return peer;
  const raw = req.headers["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const hop = header?.split(",").pop()?.trim();
  return hop || peer;
}

export function createIpRateLimiter(options: { capacity: number; refillPerMs: number }) {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  let lastPruneAt = 0;

  function refill(bucket: { tokens: number; updatedAt: number }, now: number): void {
    const elapsed = now - bucket.updatedAt;
    bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * options.refillPerMs);
    bucket.updatedAt = now;
  }

  return {
    /** Take one token for `ip`. Returns false when the bucket is empty. */
    take(ip: string, now = Date.now()): boolean {
      if (buckets.size > PRUNE_THRESHOLD && now - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = now;
        for (const [key, bucket] of buckets) {
          refill(bucket, now);
          if (bucket.tokens >= options.capacity) buckets.delete(key);
        }
      }
      let bucket = buckets.get(ip);
      if (!bucket) {
        bucket = { tokens: options.capacity, updatedAt: now };
        buckets.set(ip, bucket);
      }
      refill(bucket, now);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    reset(): void {
      buckets.clear();
      lastPruneAt = 0;
    },
  };
}
