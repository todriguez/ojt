/**
 * POST /api/v3/federation/bundle
 *
 * Inbound federation endpoint. A peer sends us a SignedBundle
 * carrying one or more ObjectPatch entries for an object; we:
 *
 *   1. Verify the envelope (trust store + recipient check).
 *   2. Enforce the handoff policy for (objectId, sender, recipient).
 *   3. Persist patches + signed-bundle rows in ONE transaction.
 *
 * Responses:
 *   200 { ok: true, patchIds, bundleIds }
 *   400 { code: <verify-error-code>, detail }
 *   403 { code: <policy reason>, detail }
 *   500 { code: "internal", detail }
 */

import { NextRequest, NextResponse } from "next/server";

import {
  BsvSdkVerifier,
  verifyBundleWithTrust,
  type SignedBundle,
} from "@semantos/session-protocol";

import {
  adminIdentity,
  handoffPolicy,
  trustStore,
} from "@/lib/federation/singletons";
import {
  persistInboundPatch,
  type InboundFederationPayload,
} from "@/lib/federation/persist";
import { logBundleIn } from "@/lib/federation/logging";

export async function POST(req: NextRequest) {
  let bundle: SignedBundle<InboundFederationPayload>;
  try {
    bundle = (await req.json()) as SignedBundle<InboundFederationPayload>;
  } catch {
    logBundleIn({ result: "bad_request", detail: "invalid JSON body" });
    return NextResponse.json(
      { code: "bad_request", detail: "invalid JSON body" },
      { status: 400 },
    );
  }

  if (
    !bundle ||
    typeof bundle !== "object" ||
    !bundle.payload ||
    typeof bundle.signature !== "string" ||
    !bundle.signer
  ) {
    logBundleIn({ result: "bad_request", detail: "malformed bundle" });
    return NextResponse.json(
      { code: "bad_request", detail: "malformed bundle" },
      { status: 400 },
    );
  }

  const verifier = new BsvSdkVerifier();
  const admin = adminIdentity();

  const verify = await verifyBundleWithTrust(bundle, verifier, trustStore(), {
    expectedRecipientCertId: admin.certId,
  });

  if (!verify.ok) {
    logBundleIn({
      result: verify.code as any,
      signerCertId: bundle.signer.certId,
      detail: verify.message,
    });
    return NextResponse.json(
      { code: verify.code, detail: verify.message },
      { status: 400 },
    );
  }

  // Trust + signature valid → policy check next.
  const payload = verify.payload;
  if (
    !payload ||
    typeof payload.objectId !== "string" ||
    !Array.isArray(payload.patches)
  ) {
    logBundleIn({
      result: "bad_request",
      signerCertId: verify.cert.certId,
      detail: "payload missing objectId/patches",
    });
    return NextResponse.json(
      { code: "bad_request", detail: "payload missing objectId/patches" },
      { status: 400 },
    );
  }

  const policyDecision = await handoffPolicy().canReceive({
    objectId: payload.objectId,
    senderCertId: verify.cert.certId,
    recipientCertId: admin.certId,
  });

  if (!policyDecision.allowed) {
    logBundleIn({
      result: "policy_denied",
      signerCertId: verify.cert.certId,
      objectId: payload.objectId,
      detail: policyDecision.reason,
    });
    return NextResponse.json(
      { code: policyDecision.reason, detail: policyDecision.reason },
      { status: 403 },
    );
  }

  // Persist atomically.
  try {
    const persisted = await persistInboundPatch(bundle, verify.cert, payload);
    logBundleIn({
      result: "ok",
      signerCertId: verify.cert.certId,
      objectId: payload.objectId,
      patchId: persisted.patchIds[0],
    });
    return NextResponse.json(
      {
        ok: true,
        patchIds: persisted.patchIds,
        bundleIds: persisted.bundleIds,
      },
      { status: 200 },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logBundleIn({
      result: "internal",
      signerCertId: verify.cert.certId,
      objectId: payload.objectId,
      detail,
    });
    return NextResponse.json({ code: "internal", detail }, { status: 500 });
  }
}
