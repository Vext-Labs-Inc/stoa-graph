/**
 * stoa-graph — federated capability registry for the Stoa open substrate.
 *
 * Public API exports. See individual modules for full documentation.
 *
 * Quick start:
 *   import { Registry, buildBundle, verifyBundle, diffBundles, embed } from "@vext-labs/stoa-graph";
 *
 *   const registry = new Registry({ capsDir: "./caps" });
 *   const caps = registry.list();
 *   const result = await buildBundle("2026-05-10", "./caps", "./bundles");
 *   const verify = await verifyBundle(result.bundlePath);
 */

export { Registry } from "./registry.js";
export type { RegistryOptions } from "./registry.js";

export { buildBundle } from "./bundle.js";
export type { BundleResult } from "./bundle.js";

export { diffBundles } from "./diff.js";
export type { DiffResult, DiffManifest } from "./diff.js";

export { verifyBundle } from "./verify.js";
export type { VerifyResult } from "./verify.js";

export { signBundle, getSigningKeyPair, _resetKeyCache } from "./sign.js";
export type { BundleSignature, SigningKeyPair } from "./sign.js";

export { embed, cosineSim, serializeEmbeddings } from "./embed.js";

export type {
  CapabilityNode,
  Attestation,
  Price,
  Reliability,
  SchemaRef,
  ManifestEntry,
  BundleManifest,
} from "./types.js";

export {
  CapabilityNodeSchema,
  AttestationSchema,
  PriceSchema,
  ReliabilitySchema,
  SchemaRefSchema,
  BundleManifestSchema,
  ManifestEntrySchema,
  UrnSchema,
  DidSchema,
} from "./types.js";
