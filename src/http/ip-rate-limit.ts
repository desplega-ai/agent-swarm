/**
 * Small in-memory per-IP token bucket for unauthenticated routes. State is
 * per process and resets on restart, which is fine for defense-in-depth on
 * routes whose credential is already unguessable.
 */

import type { IncomingMessage } from "node:http";

/** Bucket count above which full (idle) buckets are pruned. */
const PRUNE_THRESHOLD = 10_000;

/**
 * Client IP for rate limiting. Uses the rightmost `X-Forwarded-For` hop (the
 * address the nearest proxy saw), else the socket address. A client that
 * spoofs the header without a proxy only splits its own budget.
 */
export function clientIp(req: IncomingMessage): string {
  const raw = req.headers["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const hop = header?.split(",").pop()?.trim();
  return hop || req.socket.remoteAddress || "unknown";
}

export function createIpRateLimiter(options: { capacity: number; refillPerMs: number }) {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();

  function refill(bucket: { tokens: number; updatedAt: number }, now: number): void {
    const elapsed = now - bucket.updatedAt;
    bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * options.refillPerMs);
    bucket.updatedAt = now;
  }

  return {
    /** Take one token for `ip`. Returns false when the bucket is empty. */
    take(ip: string, now = Date.now()): boolean {
      if (buckets.size > PRUNE_THRESHOLD) {
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
    },
  };
}
