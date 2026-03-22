import { z } from "zod";

// ─────────────────────────────────────────────
// Environment configuration with Zod validation
//
// Required vars must always be set.
// Optional vars trigger adapter fallbacks (mock OTP, in-memory rate limit, PGlite).
// ─────────────────────────────────────────────

const configSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // ── Always required ──────────────────────
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD_HASH: z.string().min(1, "ADMIN_PASSWORD_HASH required (salt:hash via scripts/hash-password.ts)"),
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-"),

  // ── Optional: dual-key rotation ──────────
  JWT_SECRET_PREVIOUS: z.string().min(32).optional(),

  // ── Optional: Postgres (falls back to PGlite) ─
  DATABASE_URL: z.string().startsWith("postgres").optional(),

  // ── Optional: Upstash Redis (falls back to in-memory) ─
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

  // ── Optional: Twilio Verify (falls back to mock OTP) ─
  TWILIO_ACCOUNT_SID: z.string().startsWith("AC").optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_VERIFY_SID: z.string().startsWith("VA").optional(),

  // ── Feature flags ────────────────────────
  UPLOADS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type AppConfig = z.infer<typeof configSchema>;

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment configuration invalid:\n${formatted}`);
  }

  _config = result.data;
  return _config;
}

// Helper predicates for adapter selection
export const hasUpstash = () => {
  const c = getConfig();
  return !!(c.UPSTASH_REDIS_REST_URL && c.UPSTASH_REDIS_REST_TOKEN);
};

export const hasTwilio = () => {
  const c = getConfig();
  return !!(c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && c.TWILIO_VERIFY_SID);
};

export const hasPostgres = () => !!getConfig().DATABASE_URL;
