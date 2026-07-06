// Rate-Limiting pro Tenant (fixed-window). Schützt vor Agenten-Schleifen/Kostenexplosion.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private max: number, private windowMs: number) {}

  check(key: string, now = Date.now()): RateLimitResult {
    let w = this.windows.get(key);
    if (!w || now >= w.resetAt) {
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
