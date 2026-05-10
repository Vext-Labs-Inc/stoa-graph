/**
 * ES256 signing helpers for Stoa bundle signatures.
 *
 * Production key management: the private key is expected in the environment
 * variable STOA_SIGNING_KEY_JWK (JSON private key JWK for an EC P-256 key).
 * Do NOT commit private keys. See SIGNING.md for key rotation procedures.
 *
 * For local development / CI, a throwaway key is generated in-process if no
 * env var is set. The throwaway key is logged as a warning and the resulting
 * signature is marked with `dev_only: true` in the sig file.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { SignJWT, importJWK, type JWK, type KeyLike, exportJWK, importPKCS8 } from "jose";

const ALG = "ES256";

export interface SigningKeyPair {
  privateKey: KeyLike;
  publicKey: KeyLike;
  /** JWK of the public key — embed in .sig files for verification */
  publicJwk: JWK;
  isDevOnly: boolean;
}

let _keyPairCache: SigningKeyPair | null = null;

/**
 * Returns the active signing key pair.
 *
 * Resolution order:
 * 1. STOA_SIGNING_KEY_JWK env var (JSON private key JWK)
 * 2. Generated throwaway EC P-256 key (dev mode — logs a warning)
 *
 * The result is cached for the process lifetime.
 */
export async function getSigningKeyPair(): Promise<SigningKeyPair> {
  if (_keyPairCache) return _keyPairCache;

  const jwkEnv = process.env["STOA_SIGNING_KEY_JWK"];

  if (jwkEnv) {
    try {
      const jwk = JSON.parse(jwkEnv) as JWK;
      const privateKey = await importJWK(jwk, ALG) as KeyLike;
      // Derive public JWK by stripping private fields
      const pubJwk: JWK = { ...jwk };
      delete pubJwk["d"];
      delete pubJwk["p"];
      delete pubJwk["q"];
      delete pubJwk["dp"];
      delete pubJwk["dq"];
      delete pubJwk["qi"];
      const publicKey = await importJWK(pubJwk, ALG) as KeyLike;
      _keyPairCache = { privateKey, publicKey, publicJwk: pubJwk, isDevOnly: false };
      return _keyPairCache;
    } catch (err) {
      throw new Error(`Failed to import STOA_SIGNING_KEY_JWK: ${err}`);
    }
  }

  // Dev-only fallback: generate a throwaway key
  console.warn(
    "[stoa-graph] WARNING: No STOA_SIGNING_KEY_JWK set. Generating a throwaway dev key. " +
      "This signature cannot be verified against a published DID document. " +
      "Set STOA_SIGNING_KEY_JWK in production."
  );

  const { privateKey: nodePK, publicKey: nodePubK } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const pkPem = nodePK.export({ type: "pkcs8", format: "pem" }) as string;
  const privateKey = await importPKCS8(pkPem, ALG) as KeyLike;

  // Export the node public key to JWK via exportJWK (accepts KeyObject)
  const pubJwk = await exportJWK(nodePubK as unknown as KeyLike);
  pubJwk.alg = ALG;
  pubJwk.use = "sig";
  const publicKey = await importJWK(pubJwk, ALG) as KeyLike;

  _keyPairCache = { privateKey, publicKey, publicJwk: pubJwk, isDevOnly: true };
  return _keyPairCache;
}

/** Reset cached key pair (useful in tests) */
export function _resetKeyCache(): void {
  _keyPairCache = null;
}

// ---------------------------------------------------------------------------
// Bundle signing
// ---------------------------------------------------------------------------

export interface BundleSignature {
  alg: string;
  /** sha256:<hex> of the bundle bytes */
  bundle_hash: string;
  /** JWS Compact Serialization over a payload encoding the bundle hash */
  jws: string;
  /** Public key JWK so verifiers can check without a DID resolution round-trip */
  public_key: JWK;
  /** ISO-8601 timestamp */
  signed_at: string;
  /** If true, signed with a dev-only throwaway key (not a production trust root) */
  dev_only: boolean;
  /** DID of the signing entity */
  signer: string;
}

/**
 * Signs a bundle (Buffer of the tar bytes) with ES256.
 *
 * The payload is a compact JWT with:
 *   sub = "stoa-bundle"
 *   iat = now
 *   bundle_hash = sha256(bundleBytes) as hex
 *   bundle_date = date string
 *   signer = signing DID
 *
 * Returns a BundleSignature object. Callers serialize to JSON and write as
 * <bundle>.sig alongside the tar file.
 */
export async function signBundle(bundleBytes: Buffer, date: string): Promise<BundleSignature> {
  const kp = await getSigningKeyPair();
  const hash = createHash("sha256").update(bundleBytes).digest("hex");
  const signerDid = process.env["STOA_SIGNER_DID"] ?? "did:web:vext.ai";
  const signedAt = new Date().toISOString();

  const jws = await new SignJWT({
    bundle_date: date,
    bundle_hash: `sha256:${hash}`,
    signer: signerDid,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setIssuer(signerDid)
    .setSubject("stoa-bundle")
    .sign(kp.privateKey);

  return {
    alg: ALG,
    bundle_hash: `sha256:${hash}`,
    jws,
    public_key: kp.publicJwk,
    signed_at: signedAt,
    dev_only: kp.isDevOnly,
    signer: signerDid,
  };
}
