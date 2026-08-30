// Per-tenant rate limiting (fixed window). Protects against agent loops and cost explosions.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private max: number, private windowMs: number) {}

  /** Drop expired windows — the tenant claim is attacker-chosen, so the key space
   *  is unbounded and stale entries would accumulate for the process lifetime. */
  private sweep(now: number): void {
    for (const [key, w] of this.windows) {
      if (now >= w.resetAt) this.windows.delete(key);
    }
  }

  check(key: string, now = Date.now()): RateLimitResult {
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
      this.sweep(now);
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    const allowed = w.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - w.count),
      resetMs: w.resetAt - now,
    };
  }
}
