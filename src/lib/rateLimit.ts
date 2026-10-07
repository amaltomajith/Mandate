/**
 * A small fixed-window rate limiter, held in this process's memory.
 *
 * Honest scope: on a serverless host each instance has its own memory, so this
 * bounds what one instance will accept, not a global rate. That is still the
 * right tool for what it is here: a cheap brake on flooding the two public
 * endpoints (the signed MCP route and the webhooks) so unauthenticated traffic
 * cannot fill a merchant's audit trail or the database with junk. Anything
 * needing a precise global limit belongs in the platform's edge layer.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

/** True while `key` is within `max` calls per `windowMs`; false once it is over. */
export function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= max;
}

/**
 * The caller's address, as far as the platform lets us know it.
 *
 * The FIRST value of X-Forwarded-For is whatever the client chose to send, so
 * trusting it lets a flooder mint a fresh rate-limit bucket on every request.
 * Prefer the headers the hosting platform sets itself, and otherwise take the
 * LAST hop, which is the one our own proxy appended.
 */
export function clientIp(headers: Headers): string {
  const platform = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  if (platform) return platform.split(",")[0].trim();
  const fwd = headers.get("x-forwarded-for");
  return fwd ? fwd.split(",").pop()!.trim() : "unknown";
}
