import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";

// ─────────────────────────────────────────────
// Password hashing with Node built-in scrypt
//
// Format: salt:hash (both hex-encoded)
// No external dependencies required.
// ─────────────────────────────────────────────

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;

  const derived = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  const hashBuffer = Buffer.from(hash, "hex");

  return timingSafeEqual(derived, hashBuffer);
}
