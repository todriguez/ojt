/**
 * Structured federation logging.
 *
 * Wraps the repo's pino logger with the two call shapes used by the
 * /api/v3 handlers:
 *
 *   logBundleIn({ result, signerCertId, patchId, detail })  -- inbound
 *   logBundleOut({ result, recipientCertId, patchId, objectId, detail })
 *     -- outbound (admin-signed exports)
 *
 * result = "ok"          → info
 * result = policy_denied / *_denied → error
 * result = everything else → warn (verification failures, bad input)
 *
 * The emitted record has a stable shape for downstream log sinks:
 *   { evt, direction, signer_cert|recipient_cert, patch_id, result, detail }
 */

import { createLogger } from "@/lib/logger";

const log = createLogger("federation");

export type BundleResult =
  | "ok"
  // verify layer
  | "invalid_signature"
  | "bad_preimage"
  | "bad_signature_encoding"
  | "pubkey_mismatch"
  | "expected_signer_mismatch"
  | "expected_recipient_mismatch"
  | "unsupported_version"
  | "unaddressed_bundle"
  // trust layer
  | "missing_cert_id"
  | "unknown_signer"
  | "revoked_cert"
  | "pubkey_cert_mismatch"
  // policy layer
  | "policy_denied"
  // persist / misc
  | "bad_request"
  | "not_found"
  | "internal";

export interface LogBundleInInput {
  result: BundleResult;
  signerCertId?: string;
  patchId?: string;
  objectId?: string;
  detail?: string;
}

export function logBundleIn(input: LogBundleInInput): void {
  const record = {
    evt: "bundle_in",
    direction: "inbound",
    signer_cert: input.signerCertId,
    patch_id: input.patchId,
    object_id: input.objectId,
    result: input.result,
    detail: input.detail,
  };

  if (input.result === "ok") {
    log.info(record, "federation.bundle_in");
  } else if (input.result === "policy_denied") {
    log.error(record, "federation.bundle_in.denied");
  } else {
    log.warn(record, "federation.bundle_in.rejected");
  }
}

export interface LogBundleOutInput {
  result: BundleResult;
  recipientCertId?: string;
  patchId?: string;
  objectId?: string;
  detail?: string;
}

export function logBundleOut(input: LogBundleOutInput): void {
  const record = {
    evt: "bundle_out",
    direction: "outbound",
    recipient_cert: input.recipientCertId,
    patch_id: input.patchId,
    object_id: input.objectId,
    result: input.result,
    detail: input.detail,
  };

  if (input.result === "ok") {
    log.info(record, "federation.bundle_out");
  } else if (input.result === "policy_denied") {
    log.error(record, "federation.bundle_out.denied");
  } else {
    log.warn(record, "federation.bundle_out.rejected");
  }
}
