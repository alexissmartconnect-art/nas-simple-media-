type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_ATTEMPTS = 10;

const MAX_BUCKETS = 50_000;

function prune(now: number): void {
  if (buckets.size < 500) return;
  for (const [k, b] of buckets.entries()) {
    if (b.resetAt <= now) buckets.delete(k);
  }
  // Hard cap so a flood of distinct keys cannot exhaust memory.
  if (buckets.size > MAX_BUCKETS) {
    const excess = buckets.size - MAX_BUCKETS;
    let i = 0;
    for (const k of buckets.keys()) {
      if (i++ >= excess) break;
      buckets.delete(k);
    }
  }
}

/**
 * Fixed-window request budget: counts this request and reports whether the
 * key exceeded `max` requests within `windowMs` (used for global per-IP limits).
 */
export function hitRateLimit(
  key: string,
  max: number,
  windowMs: number
): { limited: boolean; retryAfterSec: number; count: number } {
  const now = Date.now();
  prune(now);
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    return { limited: true, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)), count: b.count };
  }
  return { limited: false, retryAfterSec: 0, count: b.count };
}

export function isRateLimited(
  key: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  windowMs = DEFAULT_WINDOW_MS
): { limited: boolean; retryAfterSec: number } {
  const now = Date.now();
  prune(now);
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.delete(key);
    return { limited: false, retryAfterSec: 0 };
  }
  if (b.count >= maxAttempts) {
    return {
      limited: true,
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
    };
  }
  return { limited: false, retryAfterSec: 0 };
}

export function recordFailedAttempt(
  key: string,
  windowMs = DEFAULT_WINDOW_MS
): number {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  b.count += 1;
  return b.count;
}

export function clearFailedAttempts(key: string): void {
  buckets.delete(key);
}

export function _clearRateLimitsForTests(): void {
  buckets.clear();
}
