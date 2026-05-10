/**
 * Stoa capability node schema — matches STOA.md §7.1 exactly.
 *
 * Every capability in the federated graph is one of these nodes, keyed by URN.
 * URN pattern: urn:stoa:cap:<vendor>.<resource>.<action>@<semver>
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const UrnSchema = z
  .string()
  .regex(
    /^urn:stoa:cap:[a-z0-9]+(\.[a-z0-9_-]+){1,4}@\d+\.\d+\.\d+$/,
    "Must be urn:stoa:cap:<vendor>.<resource>.<action>@<semver>"
  );

export const DidSchema = z
  .string()
  .regex(/^did:(web|key|plc):.+/, "Must be a valid DID (did:web:, did:key:, did:plc:)");

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

export const AttestationSchema = z.object({
  by: DidSchema.describe("DID of the attesting entity"),
  kind: z
    .string()
    .describe(
      "Attestation kind: self | third-party:<name> | conformance:L<1-4> | compatibility:tested"
    ),
  sig: z.string().describe("Base64url JWS compact detached signature or PLACEHOLDER for seed data"),
  ts: z.string().datetime().optional().describe("ISO-8601 timestamp of the attestation"),
});

export const SchemaRefSchema = z.object({
  input_ref: z.string().url().describe("URL of the JSON Schema for capability inputs"),
  output_ref: z.string().url().describe("URL of the JSON Schema for capability outputs"),
  schema_hash: z
    .string()
    .optional()
    .describe("sha256:<hex> of the concatenated schema content (for integrity checking)"),
});

export const PriceTierSchema = z.object({
  label: z.string(),
  unit: z.string().describe("e.g. per_request, per_1k_tokens, per_file, per_finding"),
  amount_cents: z.number().nonnegative(),
  applies_after: z.number().nonnegative().optional().describe("Units before this tier activates"),
});

export const PriceSchema = z.object({
  oracle: z
    .string()
    .default("x402:price-feed-v1")
    .describe("Price oracle identifier; x402:price-feed-v1 is the canonical Stoa oracle"),
  current_cents: z
    .number()
    .nonnegative()
    .describe("Current price in USD cents per base unit (per request unless tiers specify)"),
  stale_after: z
    .number()
    .int()
    .positive()
    .default(300)
    .describe("Seconds after which the price is considered stale and must be re-fetched"),
  tiers: z.array(PriceTierSchema).optional().describe("Volume or type-based pricing tiers"),
});

export const ReliabilitySchema = z.object({
  window_24h: z
    .number()
    .min(0)
    .max(1)
    .describe("Uptime / success rate over trailing 24 hours (0.0–1.0)"),
  p50_latency_ms: z.number().nonnegative(),
  p95_latency_ms: z.number().nonnegative(),
  p99_latency_ms: z.number().nonnegative(),
  samples: z.number().int().nonnegative().describe("Number of samples in the measurement window"),
});

export const DeprecationSchema = z
  .object({
    sunset_at: z.string().datetime().describe("ISO-8601 date when this capability is removed"),
    reason: z.string(),
    replacement: UrnSchema.optional().describe("URN of the recommended replacement capability"),
  })
  .nullable();

// ---------------------------------------------------------------------------
// The canonical capability node — §7.1
// ---------------------------------------------------------------------------

export const CapabilityNodeSchema = z.object({
  /**
   * Stable, globally unique identifier.
   * Pattern: urn:stoa:cap:<vendor>.<resource>.<action>@<semver>
   * Agents key off URNs, never off paths or URLs (which drift).
   */
  urn: UrnSchema,

  /**
   * Vendor DID. Used to verify attestation signatures and receipt signatures.
   * For Vext capabilities: did:web:vext.ai
   */
  vendor_did: DidSchema,

  /**
   * JSON Schema references for typed I/O — agents validate inputs before calling.
   */
  schema: SchemaRefSchema,

  /**
   * 768-dimensional float32 embedding for semantic / NL retrieval.
   * For v0, generated deterministically from the capability summary + description
   * via SHA-256 expansion (see src/embed.ts).
   *
   * TODO: replace with @xenova/transformers BAAI/bge-small-en-v1.5 or equivalent
   * once the ML dep is acceptable. The deterministic hash embedding is stable
   * across builds and sufficient for cosine-similarity retrieval in tests.
   */
  embedding: z.array(z.number()).length(768).describe("768-d float32 embedding vector"),

  /**
   * Attestation chain. At minimum one attestation (self).
   * Foundation conformance attestation is added when the cap passes the test suite.
   */
  attestations: z.array(AttestationSchema).min(1),

  /**
   * Price declaration. Agents use this in cost-governance before calling.
   */
  price: PriceSchema,

  /**
   * Measured reliability. Vendors publish; the Stoa foundation aggregates
   * across registries and overwrites this field in the signed daily bundle.
   */
  reliability: ReliabilitySchema,

  /**
   * Privacy zones where this capability may be called.
   * ISO 3166-1 alpha-2 country codes or "EU" for GDPR zone.
   * PHI caps must list only compliant jurisdictions.
   */
  privacy_zones: z.array(z.string()).min(1),

  /**
   * URN of the compensating capability (the undo action).
   * null = no compensation path (irrevocable; requires human confirmation).
   * string = URN of the capability to call with the output ID to undo this action.
   */
  compensation: z.union([UrnSchema, z.null()]),

  /**
   * Side-effect class for planner routing and saga compensation.
   * Pattern: <domain>.<subdomain>.<action_class>
   * Examples: external.crm.write, external.email.send, read.query, internal.compute
   */
  side_effect_class: z.string(),

  /**
   * Capability-level OAuth scopes required.
   * Pattern: <vendor>:<resource>:<action>
   */
  scopes_required: z.array(z.string()),

  /**
   * Deprecation info. null = active capability.
   */
  deprecation: DeprecationSchema,

  // ---------------------------------------------------------------------------
  // Extended fields (beyond §7.1 minimum — all optional)
  // ---------------------------------------------------------------------------

  /** Short human-readable summary for embedding generation and display */
  summary: z.string().optional(),

  /** Longer capability description */
  description: z.string().optional(),

  /** Human confirmation requirement */
  human_confirmation_class: z
    .enum(["none", "soft", "hard"])
    .default("none")
    .describe("none=no gate, soft=in-loop advisory, hard=mandatory human approval before execute"),

  /** Idempotency semantics */
  idempotency: z
    .enum(["none", "client-key", "natural-key", "server-dedupe"])
    .default("client-key"),

  /** Stoa/1 side-effect kind */
  side_effect_kind: z
    .enum(["read", "create", "update", "delete", "action", "query"])
    .default("action"),

  /** ISO-8601 timestamp of last update to this node */
  updated_at: z.string().datetime().optional(),
});

export type CapabilityNode = z.infer<typeof CapabilityNodeSchema>;
export type Attestation = z.infer<typeof AttestationSchema>;
export type Price = z.infer<typeof PriceSchema>;
export type Reliability = z.infer<typeof ReliabilitySchema>;
export type SchemaRef = z.infer<typeof SchemaRefSchema>;

// ---------------------------------------------------------------------------
// Manifest types (for bundle)
// ---------------------------------------------------------------------------

export const ManifestEntrySchema = z.object({
  urn: UrnSchema,
  file: z.string().describe("Relative path within the bundle tar"),
  content_hash: z.string().describe("sha256:<hex> of the raw JSON file bytes"),
  size_bytes: z.number().int().nonnegative(),
});

export const BundleManifestSchema = z.object({
  bundle_version: z.string().describe("Date string YYYY-MM-DD"),
  generated_at: z.string().datetime(),
  registry: z.string().describe("Registry origin, e.g. caps.stoa.foundation"),
  caps_count: z.number().int().nonnegative(),
  entries: z.array(ManifestEntrySchema),
  embeddings_bin: z
    .string()
    .describe("Relative path to the binary embeddings file within the bundle"),
  embeddings_idx: z
    .string()
    .describe("Relative path to the embeddings index (JSON URN→offset mapping)"),
  previous_bundle: z.string().nullable().describe("Date of previous bundle, for diff chaining"),
  schema_version: z.literal("stoa-graph-0.1"),
});

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
export type BundleManifest = z.infer<typeof BundleManifestSchema>;
