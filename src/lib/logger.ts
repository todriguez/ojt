import pino from "pino";

// ─────────────────────────────────────────────
// Structured logger (pino)
//
// Usage:
//   import { createLogger } from "@/lib/logger";
//   const log = createLogger("auth");
//   log.info({ email, ip }, "admin.login.success");
//   log.warn({ phone, ip, reason }, "otp.send.failure");
// ─────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== "production";

const baseLogger = pino({
  level: isDev ? "debug" : "info",
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }
    : {}),
  base: {
    service: "oddjobtodd",
    env: process.env.NODE_ENV || "development",
  },
});

export function createLogger(context: string) {
  return baseLogger.child({ context });
}

export { baseLogger as logger };
