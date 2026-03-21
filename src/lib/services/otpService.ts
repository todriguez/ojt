import { createLogger } from "@/lib/logger";
import { hasTwilio, getConfig } from "@/lib/config";

// ─────────────────────────────────────────────
// OTP Service Adapter
//
// Real: Twilio Verify (when TWILIO_ACCOUNT_SID is set)
// Mock: In-memory, code is always 123456 (local dev)
// ─────────────────────────────────────────────

const log = createLogger("otp");

export interface OtpService {
  sendCode(phone: string): Promise<{ success: boolean }>;
  verifyCode(phone: string, code: string): Promise<{ valid: boolean }>;
}

// ── Twilio implementation ──────────────────

class TwilioOtpService implements OtpService {
  private client: ReturnType<typeof import("twilio")> | null = null;
  private verifySid: string;

  constructor() {
    const config = getConfig();
    this.verifySid = config.TWILIO_VERIFY_SID!;
  }

  private async getClient() {
    if (!this.client) {
      const twilio = (await import("twilio")).default;
      const config = getConfig();
      this.client = twilio(config.TWILIO_ACCOUNT_SID!, config.TWILIO_AUTH_TOKEN!);
    }
    return this.client;
  }

  async sendCode(phone: string): Promise<{ success: boolean }> {
    try {
      const client = await this.getClient();
      const verification = await client.verify.v2
        .services(this.verifySid)
        .verifications.create({ to: phone, channel: "sms" });

      log.info({ phone: maskPhone(phone), status: verification.status }, "otp.send.success");
      return { success: true };
    } catch (err) {
      log.error(
        { phone: maskPhone(phone), error: err instanceof Error ? err.message : String(err) },
        "otp.send.failure"
      );
      return { success: false };
    }
  }

  async verifyCode(phone: string, code: string): Promise<{ valid: boolean }> {
    try {
      const client = await this.getClient();
      const check = await client.verify.v2
        .services(this.verifySid)
        .verificationChecks.create({ to: phone, code });

      const valid = check.status === "approved";
      if (valid) {
        log.info({ phone: maskPhone(phone) }, "otp.verify.success");
      } else {
        log.warn({ phone: maskPhone(phone), status: check.status }, "otp.verify.failure");
      }
      return { valid };
    } catch (err) {
      log.error(
        { phone: maskPhone(phone), error: err instanceof Error ? err.message : String(err) },
        "otp.verify.failure"
      );
      return { valid: false };
    }
  }
}

// ── Mock implementation (local dev) ────────

class MockOtpService implements OtpService {
  private static MOCK_CODE = "123456";

  async sendCode(phone: string): Promise<{ success: boolean }> {
    log.info(
      { phone: maskPhone(phone), mockCode: MockOtpService.MOCK_CODE },
      "otp.mock.send — use code 123456"
    );
    return { success: true };
  }

  async verifyCode(phone: string, code: string): Promise<{ valid: boolean }> {
    const valid = code === MockOtpService.MOCK_CODE;
    if (valid) {
      log.info({ phone: maskPhone(phone) }, "otp.mock.verify.success");
    } else {
      log.warn({ phone: maskPhone(phone) }, "otp.mock.verify.failure — expected 123456");
    }
    return { valid };
  }
}

// ── Factory ────────────────────────────────

let _instance: OtpService | null = null;

export function getOtpService(): OtpService {
  if (_instance) return _instance;
  _instance = hasTwilio() ? new TwilioOtpService() : new MockOtpService();
  return _instance;
}

// ── Helpers ────────────────────────────────

function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return phone.slice(0, -4).replace(/./g, "*") + phone.slice(-4);
}

export function normalizePhone(phone: string): string {
  // Strip everything except digits and leading +
  const cleaned = phone.replace(/[^\d+]/g, "");
  // Australian numbers: if starts with 0, prepend +61
  if (cleaned.startsWith("0") && cleaned.length === 10) {
    return "+61" + cleaned.slice(1);
  }
  // Already E.164
  if (cleaned.startsWith("+")) return cleaned;
  // Assume Australian if no country code
  return "+61" + cleaned;
}
