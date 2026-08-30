// Proves: fixed-window rate limiting per tenant (guards against agent loops and cost explosions).

import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/ratelimit.js";

test("allows up to max, then denies", () => {
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.check("acme", 0).allowed, true);  // 1
  assert.equal(rl.check("acme", 0).allowed, true);  // 2
  assert.equal(rl.check("acme", 0).allowed, true);  // 3
  const fourth = rl.check("acme", 0);
  assert.equal(fourth.allowed, false);              // 4 -> denied
  assert.equal(fourth.remaining, 0);
  assert.equal(fourth.resetMs > 0, true);
});

test("remaining counts down", () => {
  const rl = new RateLimiter(5, 60_000);
  assert.equal(rl.check("acme", 0).remaining, 4);
  assert.equal(rl.check("acme", 0).remaining, 3);
});

test("limits are per-tenant (one tenant's burst does not affect another)", () => {
  const rl = new RateLimiter(2, 60_000);
  rl.check("acme", 0);
  rl.check("acme", 0);
  assert.equal(rl.check("acme", 0).allowed, false); // acme exhausted
  assert.equal(rl.check("globex", 0).allowed, true); // globex unaffected
});

test("window resets after windowMs elapses", () => {
  const rl = new RateLimiter(1, 1_000);
  assert.equal(rl.check("acme", 0).allowed, true);
  assert.equal(rl.check("acme", 500).allowed, false); // still in window
  assert.equal(rl.check("acme", 1_000).allowed, true); // new window
});
