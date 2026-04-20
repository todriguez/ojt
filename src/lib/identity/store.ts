/**
 * Known-cert store bootstrap + REA peer loader.
 *
 * This is the **receiver-side allowlist** for verifyBundleWithTrust.
 * It's populated once at boot from two sources:
 *
 *   1. The admin identity (always present — root of trust).
 *   2. Zero or more REA peer identities, derived from phone numbers in
 *      OJT_REA_PEERS_JSON.
 *
 * The store returned by session-protocol's createInMemoryKnownCertStore
 * is async (get/add/has/revoke/list return Promises). Request handlers
 * can call .has / .get but MUST NOT call .add at request time —
 * mutating the trust registry mid-flight is a security bug. That rule
 * is not enforced by the type system here; it's enforced by code
 * review + the fact that no OJT route code should import this module
 * for anything but .has / .get.
 */

import {
  createInMemoryKnownCertStore,
  type KnownCertStore,
} from "@semantos/session-protocol";

import type { OjtIdentity } from "./identity";
import { identityToCertRecord } from "./bridge";
import { phoneToIdentity } from "./identity";

export interface BootKnownCertStoreOpts {
  adminId: OjtIdentity;
  reaPeers?: OjtIdentity[];
}

/**
 * Create and populate a KnownCertStore with the admin cert and any
 * supplied REA peer certs. Returns the SDK's in-memory store — the
 * same shape Plexus's real store will implement, so callers can swap
 * implementations without changes.
 *
 * `add` is called synchronously (awaited) at boot; there's no
 * concurrency here because this is called once at module init.
 */
export function bootKnownCertStore(
  opts: BootKnownCertStoreOpts,
): KnownCertStore {
  const store = createInMemoryKnownCertStore();

  // Seed synchronously via Promise chain — callers get a ready-to-use
  // store. For the in-memory impl these promises resolve in a
  // microtask so a test that `await`s a `.has` immediately after
  // `bootKnownCertStore` sees everything we seeded.
  const seed = [opts.adminId, ...(opts.reaPeers ?? [])];
  for (const id of seed) {
    // Fire-and-forget at boot time — the in-memory store's add() is
    // synchronous under the hood (returns already-resolved promise).
    // If a future store implementation needs real I/O here, callers
    // should await the returned store factory instead.
    void store.add(identityToCertRecord(id));
  }

  return store;
}

/**
 * Read `OJT_REA_PEERS_JSON` and hydrate each `{phone}` entry into an
 * OjtIdentity with role='rea'. Empty / missing / '[]' all return [].
 *
 * JSON shape: `[{"phone": "+61..."}, ...]`. Any entry without a phone,
 * or any phone that fails normalization, throws — silent skip would
 * leave the store missing a peer you thought was trusted.
 */
export function loadReaPeersFromEnv(): OjtIdentity[] {
  const raw = process.env.OJT_REA_PEERS_JSON?.trim();
  if (!raw || raw === "[]") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadReaPeersFromEnv: OJT_REA_PEERS_JSON is not valid JSON: ${
        (err as Error).message
      }`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      "loadReaPeersFromEnv: OJT_REA_PEERS_JSON must be a JSON array",
    );
  }

  return parsed.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || !("phone" in entry)) {
      throw new Error(
        `loadReaPeersFromEnv: entry ${idx} missing required "phone" field`,
      );
    }
    const phone = (entry as { phone: unknown }).phone;
    if (typeof phone !== "string" || phone.length === 0) {
      throw new Error(
        `loadReaPeersFromEnv: entry ${idx} has non-string "phone"`,
      );
    }
    return phoneToIdentity(phone, "rea");
  });
}
