import { createLogger } from "@/lib/logger";
import { hasUpstash, getConfig } from "@/lib/config";

// ─────────────────────────────────────────────
// Rate Limiter Adapter
//
// Real: Upstash Redis + @upstash/ratelimit (when UPSTASH_REDIS_REST_URL is set)
// Mock: In-memory sliding window (local dev — resets on restart)
// ─────────────────────────────────────────────

const log = createLogger("rateLimit");

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number; // seconds until next allowed request
}

interface RateLimiterConfig {
  /** Max requests in the window */
  limit: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

// ── Named limiter configs ──────────────────

const LIMITER_CONFIGS = {
  otpSendPerPhone: { limit: 3, windowSeconds: 600 },       // 3 per 10 min
  otpSendPerIp: { limit: 10, windowSeconds: 3600 },        // 10 per hour
  otpVerify: { limit: 5, windowSeconds: 900 },              // 5 per 15 min
  chatPerSession: { limit: 30, windowSeconds: 600 },        // 30 per 10 min
  chatPerIp: { limit: 60, windowSeconds: 3600 },            // 60 per hour
  adminLogin: { limit: 5, windowSeconds: 900 },             // 5 per 15 min
  newConversationPerIp: { limit: 5, windowSeconds: 3600 },  // 5 per hour
} as const;

export type LimiterName = keyof typeof LIMITER_CONFIGS;

// ── Interface ──────────────────────────────

interface RateLimiter {
  check(name: LimiterName, key: string): Promise<RateLimitResult>;
}

// ── Upstash implementation ─────────────────

class UpstashRateLimiter implements RateLimiter {
  private limiters = new Map<LimiterName, import("@upstash/ratelimit").Ratelimit>();
  private initialized = false;

  private async init() {
    if (this.initialized) return;

    const { Ratelimit } = await import("@upstash/ratelimit");
    const { Redis } = await import("@upstash/redis");
    const config = getConfig();

    const redis = new Redis({
      url: config.UPSTASH_REDIS_REST_URL!,
      token: config.UPSTASH_REDIS_REST_TOKEN!,
    });

    for (const [name, cfg] of Object.entries(LIMITER_CONFIGS)) {
      this.limiters.set(name as LimiterName, new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(cfg.limit, `${cfg.windowSeconds} s`),
        prefix: `ojt:rl:${name}`,
      }));
    }

    this.initialized = true;
  }

  async check(name: LimiterName, key: string): Promise<RateLimitResult> {
    await this.init();
    const limiter = this.limiters.get(name)!;
    const result = await limiter.limit(key);

    if (!result.success) {
      const retryAfter = Math.ceil((result.reset - Date.now()) / 1000);
      log.warn({ limiter: name, key, retryAfter }, "ratelimit.exceeded");
      return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
    }

    return { allowed: true };
  }
}

// ── In-memory implementation (local dev) ───

class InMemoryRateLimiter implements RateLimiter {
  // key → array of timestamps (ms)
  private store = new Map<string, number[]>();

  async check(name: LimiterName, key: string): Promise<RateLimitResult> {
    const cfg = LIMITER_CONFIGS[name];
    const fullKey = `${name}:${key}`;
    const now = Date.now();
    const windowStart = now - cfg.windowSeconds * 1000;

    // Get existing timestamps and prune old ones
    const timestamps = (this.store.get(fullKey) || []).filter((t) => t > windowStart);

    if (timestamps.length >= cfg.limit) {
      const oldest = timestamps[0];
      const retryAfter = Math.ceil((oldest + cfg.windowSeconds * 1000 - now) / 1000);
      log.warn({ limiter: name, key, retryAfter }, "ratelimit.exceeded (in-memory)");
      this.store.set(fullKey, timestamps);
      return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
    }

    timestamps.push(now);
    this.store.set(fullKey, timestamps);
    return { allowed: true };
  }
}

// ── Factory (singleton) ────────────────────

let _instance: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (_instance) return _instance;
  _instance = hasUpstash() ? new UpstashRateLimiter() : new InMemoryRateLimiter();
  return _instance;
}

// ── Convenience helper ─────────────────────

export async function checkRateLimit(
  name: LimiterName,
  key: string
): Promise<RateLimitResult> {
  return getRateLimiter().check(name, key);
}
