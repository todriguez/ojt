import { SignJWT, jwtVerify, errors } from "jose";
import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";

// ─────────────────────────────────────────────
// JWT sign/verify with jose
//
// Supports dual-key rotation:
//   JWT_SECRET = current signing key
//   JWT_SECRET_PREVIOUS = old key (verify only)
//
// To rotate: move current to PREVIOUS, set new SECRET.
// ─────────────────────────────────────────────

const log = createLogger("jwt");

export interface AdminJwtPayload {
  type: "admin";
  email: string;
  sessionId: string;
}

export interface CustomerJwtPayload {
  type: "customer";
  customerId: string;
  phone: string;
  sessionId: string;
}

export type JwtPayload = AdminJwtPayload | CustomerJwtPayload;

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(getConfig().JWT_SECRET);
}

function getPreviousSecretKey(): Uint8Array | null {
  const prev = getConfig().JWT_SECRET_PREVIOUS;
  if (!prev) return null;
  return new TextEncoder().encode(prev);
}

export async function signJwt(
  payload: JwtPayload,
  expiresIn: string // e.g. "8h" or "7d"
): Promise<string> {
  return new SignJWT({ ...payload } as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setIssuer("oddjobtodd")
    .sign(getSecretKey());
}

export async function verifyJwt(token: string): Promise<JwtPayload> {
  // Try current key first
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      issuer: "oddjobtodd",
    });
    return payload as unknown as JwtPayload;
  } catch (err) {
    // If expired or invalid, don't try the previous key
    if (err instanceof errors.JWTExpired) {
      throw err;
    }

    // Try previous key for rotation
    const prevKey = getPreviousSecretKey();
    if (prevKey) {
      try {
        const { payload } = await jwtVerify(token, prevKey, {
          issuer: "oddjobtodd",
        });
        log.info("JWT verified with previous key (rotation in progress)");
        return payload as unknown as JwtPayload;
      } catch {
        // Both keys failed
      }
    }

    throw err;
  }
}

// Lightweight verify for edge middleware (no DB check)
export async function verifyJwtEdge(token: string): Promise<JwtPayload | null> {
  try {
    return await verifyJwt(token);
  } catch {
    return null;
  }
}
