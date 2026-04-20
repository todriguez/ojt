/**
 * Atomic inbound-bundle persistence.
 *
 * One drizzle transaction writes both:
 *   - sem_object_patches (the logical delta)
 *   - sem_signed_bundles (the envelope/signature record)
 *
 * Either both land or neither does — the federation audit trail must
 * not diverge from patch history.
 *
 * P4 scope: accept payloads shaped as an ObjectPatch-bearing bundle.
 * Patch authoring is upstream of us — we persist exactly what the
 * sender signed. `verify.cert` (the resolved trust record) is passed
 * in so we never re-resolve it from the store.
 */

import { randomUUID } from "node:crypto";

import type { SignedBundle, CertRecord } from "@semantos/session-protocol";

import { getDb } from "@/lib/db/client";
import {
  objectPatches,
  semSignedBundles,
  semanticObjects,
} from "@/lib/semantos-kernel/schema.core";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";

// ── Payload shape (P4 inbound federation bundle) ─────────────────

export interface ObjectPatchPayload {
  // Required fields for a patch row.
  objectId: string;
  fromVersion: number;
  toVersion: number;
  prevStateHash: string;
  newStateHash: string;
  patchKind:
    | "extraction"
    | "user_edit"
    | "system_rule"
    | "score_update"
    | "status_change"
    | "entity_link"
    | "provenance";
  delta: unknown;
  deltaCount?: number;
  source: string;
  evidenceRef?: string | null;
  authorObjectId?: string | null;

  // Federation fields.
  timestamp?: number;
  facetId?: string | null;
  facetCapabilities?: number[] | null;
  lexicon?: string | null;
}

export interface InboundFederationPayload {
  /** The object this patch belongs to. */
  objectId: string;
  /** One or more patches to apply atomically. */
  patches: ObjectPatchPayload[];
}

export interface PersistResult {
  patchIds: string[];
  bundleIds: string[];
}

/**
 * Persist an inbound signed bundle in one transaction.
 *
 * - Inserts all patches into sem_object_patches.
 * - Inserts a sem_signed_bundles row per patch, tagging each with the
 *   signer/recipient identities pulled off the envelope.
 * - Upserts the parent semantic_object row if it doesn't exist yet
 *   (a peer may send the first patch for a new object).
 *
 * Throws on any failure — the caller maps the error to a 500.
 * Drizzle wraps both inserts in a single tx so a failure in either
 * inner statement rolls both back.
 */
export async function persistInboundPatch(
  bundle: SignedBundle<InboundFederationPayload>,
  cert: CertRecord,
  payload: InboundFederationPayload,
): Promise<PersistResult> {
  const db = await getDb();

  const signerBca = bundle.signer.bca;
  const signerPubkeyHex = bundle.signer.pubkeyHex;
  const signerCertId = bundle.signer.certId ?? cert.certId;
  const recipient = bundle.recipient;
  const signedAt = new Date(bundle.signedAt);

  return await db.transaction(async (tx) => {
    // Ensure parent object exists — a new inbound object on first
    // federation pass is legitimate (OJT may not have seen it yet).
    const existing = await tx
      .select({ id: semanticObjects.id })
      .from(semanticObjects)
      .where(eq(semanticObjects.id, payload.objectId))
      .limit(1);

    if (existing.length === 0) {
      await tx.insert(semanticObjects).values({
        id: payload.objectId,
        vertical: "trades",
        objectKind: "job",
        typeHash: "0".repeat(64),
        currentStateHash: "",
      });
    }

    const patchIds: string[] = [];
    const bundleIds: string[] = [];

    for (const p of payload.patches) {
      const [insertedPatch] = await tx
        .insert(objectPatches)
        .values({
          objectId: p.objectId,
          fromVersion: p.fromVersion,
          toVersion: p.toVersion,
          prevStateHash: p.prevStateHash,
          newStateHash: p.newStateHash,
          patchKind: p.patchKind,
          delta: p.delta as any,
          deltaCount: p.deltaCount ?? 0,
          source: p.source,
          evidenceRef: p.evidenceRef ?? undefined,
          authorObjectId: p.authorObjectId ?? undefined,
          timestamp: p.timestamp ?? undefined,
          facetId: p.facetId ?? undefined,
          facetCapabilities: p.facetCapabilities ?? undefined,
          lexicon: p.lexicon ?? undefined,
        })
        .returning({ id: objectPatches.id });
      patchIds.push(insertedPatch.id);

      const bundleId = `bundle-${randomUUID()}`;
      await tx.insert(semSignedBundles).values({
        id: bundleId,
        patchId: insertedPatch.id,
        bundleVersion: bundle.version,
        signerBca,
        signerPubkeyHex,
        signerCertId,
        recipientBca: recipient?.bca ?? undefined,
        recipientPubkeyHex: recipient?.pubkeyHex ?? undefined,
        recipientCertId: recipient?.certId ?? undefined,
        signature: bundle.signature,
        signedAt,
        direction: "inbound",
        verified: true,
      });
      bundleIds.push(bundleId);
    }

    return { patchIds, bundleIds };
  });
}

// Keep sql import used for potential future raw helpers; avoids
// "unused import" lint noise if we grow this module.
export { sql };
