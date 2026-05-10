/**
 * Bundle signature verification.
 *
 * Reads a <bundle>.sig JSON file and verifies:
 * 1. The JWS signature is valid for the embedded public key.
 * 2. The bundle_hash in the JWT payload matches the actual SHA-256 of the bundle bytes.
 *
 * Future: also verify the public key against the signer's DID document.
 * TODO: DID resolution (did:web → HTTPS /.well-known/did.json → extract verification key)
 *       is a network operation and deferred to v0.2. For now the sig file embeds
 *       the public JWK directly.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { jwtVerify, importJWK, type JWK } from "jose";

export interface VerifyResult {
  ok: boolean;
  /** Computed SHA-256 of the bundle bytes */
  computed_hash: string;
  /** Bundle hash declared in the JWS payload */
  declared_hash: string;
  hashes_match: boolean;
  signature_valid: boolean;
  signer: string;
  signed_at: string;
  dev_only: boolean;
  error?: string;
}

/**
 * Verifies a bundle and its accompanying .sig file.
 *
 * @param bundlePath  Path to the tar(.gz/.zst) bundle file
 * @param sigPath     Path to the .sig JSON file (defaults to bundlePath + ".sig")
 */
export async function verifyBundle(
  bundlePath: string,
  sigPath?: string
): Promise<VerifyResult> {
  const resolvedSigPath = sigPath ?? bundlePath + ".sig";

  let bundleBytes: Buffer;
  let sigJson: string;

  try {
    bundleBytes = readFileSync(bundlePath);
  } catch (err) {
    return {
      ok: false,
      computed_hash: "",
      declared_hash: "",
      hashes_match: false,
      signature_valid: false,
      signer: "",
      signed_at: "",
      dev_only: false,
      error: `Cannot read bundle: ${err}`,
    };
  }

  try {
    sigJson = readFileSync(resolvedSigPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      computed_hash: "",
      declared_hash: "",
      hashes_match: false,
      signature_valid: false,
      signer: "",
      signed_at: "",
      dev_only: false,
      error: `Cannot read sig file: ${err}`,
    };
  }

  let sig: {
    alg: string;
    bundle_hash: string;
    jws: string;
    public_key: JWK;
    signed_at: string;
    dev_only: boolean;
    signer: string;
  };

  try {
    sig = JSON.parse(sigJson);
  } catch (err) {
    return {
      ok: false,
      computed_hash: "",
      declared_hash: "",
      hashes_match: false,
      signature_valid: false,
      signer: "",
      signed_at: "",
      dev_only: false,
      error: `Cannot parse sig file: ${err}`,
    };
  }

  // Compute actual bundle hash
  const computedHash = `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`;
  const declaredHash = sig.bundle_hash;
  const hashesMatch = computedHash === declaredHash;

  // Verify JWS
  let signatureValid = false;
  let jwsPayload: Record<string, unknown> = {};

  try {
    const publicKey = await importJWK(sig.public_key, sig.alg);
    const { payload } = await jwtVerify(sig.jws, publicKey, {
      algorithms: [sig.alg],
    });
    signatureValid = true;
    jwsPayload = payload as Record<string, unknown>;
  } catch (err) {
    signatureValid = false;
  }

  // Cross-check payload hash vs actual hash
  const payloadHash = (jwsPayload["bundle_hash"] as string) ?? "";
  const fullMatch = hashesMatch && signatureValid && payloadHash === computedHash;

  return {
    ok: fullMatch,
    computed_hash: computedHash,
    declared_hash: declaredHash,
    hashes_match: hashesMatch,
    signature_valid: signatureValid,
    signer: sig.signer,
    signed_at: sig.signed_at,
    dev_only: sig.dev_only,
    error: fullMatch ? undefined : "Verification failed — see individual fields",
  };
}
