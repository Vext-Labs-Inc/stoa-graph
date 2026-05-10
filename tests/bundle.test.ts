/**
 * stoa-graph integration tests.
 *
 * Tests:
 * 1. Embed is deterministic and 768-d
 * 2. Registry: add, list, get, validate
 * 3. Build a bundle, check structure
 * 4. Verify the bundle's signature
 * 5. Diff two bundles (add a cap, rebuild, diff)
 * 6. Search the registry by embedding
 * 7. Zod schema rejects invalid caps
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { embed, cosineSim } from "../src/embed.js";
import { Registry } from "../src/registry.js";
import { buildBundle } from "../src/bundle.js";
import { verifyBundle } from "../src/verify.js";
import { diffBundles } from "../src/diff.js";
import { CapabilityNodeSchema } from "../src/types.js";
import { _resetKeyCache } from "../src/sign.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_ROOT = join(tmpdir(), `stoa-graph-test-${Date.now()}`);
const CAPS_DIR = join(TEST_ROOT, "caps");
const BUNDLES_DIR = join(TEST_ROOT, "bundles");

/** Minimal valid capability node (embedding will be auto-filled by registry) */
function makeCap(suffix: string) {
  return {
    urn: `urn:stoa:cap:test.widget.${suffix}@1.0.0`,
    vendor_did: "did:web:example.com",
    summary: `Test widget ${suffix}`,
    description: `A test capability for ${suffix} operations`,
    schema: {
      input_ref: `https://example.com/schemas/${suffix}-input.json`,
      output_ref: `https://example.com/schemas/${suffix}-output.json`,
    },
    // Intentionally omit embedding — registry should auto-fill
    embedding: new Array(768).fill(0).map((_, i) => (i % 10) / 10),
    attestations: [{ by: "did:web:example.com", kind: "self", sig: "PLACEHOLDER" }],
    price: {
      oracle: "x402:price-feed-v1",
      current_cents: 5,
      stale_after: 300,
    },
    reliability: {
      window_24h: 0.99,
      p50_latency_ms: 100,
      p95_latency_ms: 300,
      p99_latency_ms: 800,
      samples: 1000,
    },
    privacy_zones: ["US"],
    compensation: null,
    side_effect_class: "internal.compute.test",
    scopes_required: ["test:widget:read"],
    deprecation: null,
  };
}

beforeAll(() => {
  mkdirSync(CAPS_DIR, { recursive: true });
  mkdirSync(BUNDLES_DIR, { recursive: true });
  // Reset any cached signing key between test runs
  _resetKeyCache();
});

afterAll(() => {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Embeddings
// ---------------------------------------------------------------------------

describe("embed()", () => {
  it("returns a 768-d vector", () => {
    const v = embed("hello world");
    expect(v).toHaveLength(768);
  });

  it("is deterministic — same text always produces same vector", () => {
    const a = embed("test capability one");
    const b = embed("test capability one");
    expect(a).toEqual(b);
  });

  it("produces different vectors for different text", () => {
    const a = embed("security vulnerability scan");
    const b = embed("legal contract review");
    expect(a).not.toEqual(b);
  });

  it("vectors are L2-normalized (|v| ≈ 1)", () => {
    const v = embed("normalize me");
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it("cosine similarity of identical vectors is 1.0", () => {
    const v = embed("same text");
    expect(cosineSim(v, v)).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// 2. Registry: add, list, get, validate
// ---------------------------------------------------------------------------

describe("Registry", () => {
  let registry: Registry;

  beforeAll(() => {
    registry = new Registry({ capsDir: CAPS_DIR, autoEmbed: false });
  });

  it("validates a valid cap with no errors", () => {
    const cap = makeCap("alpha");
    const errors = registry.validate(cap);
    expect(errors).toHaveLength(0);
  });

  it("rejects a cap with invalid URN", () => {
    const bad = { ...makeCap("beta"), urn: "not-a-urn" };
    const errors = registry.validate(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/urn/i);
  });

  it("rejects a cap with invalid DID", () => {
    const bad = { ...makeCap("gamma"), vendor_did: "bad-did" };
    const errors = registry.validate(bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a cap with wrong embedding dimension", () => {
    const bad = { ...makeCap("delta"), embedding: [0.1, 0.2, 0.3] };
    const errors = registry.validate(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/768/);
  });

  it("adds a cap and returns it", () => {
    const cap = makeCap("alpha");
    const added = registry.add(cap);
    expect(added.urn).toBe("urn:stoa:cap:test.widget.alpha@1.0.0");
  });

  it("list() returns added caps", () => {
    const caps = registry.list();
    expect(caps.length).toBeGreaterThanOrEqual(1);
    const urns = caps.map((c) => c.urn);
    expect(urns).toContain("urn:stoa:cap:test.widget.alpha@1.0.0");
  });

  it("get() retrieves a cap by URN", () => {
    const cap = registry.get("urn:stoa:cap:test.widget.alpha@1.0.0");
    expect(cap).not.toBeNull();
    expect(cap!.summary).toBe("Test widget alpha");
  });

  it("get() returns null for unknown URN", () => {
    const cap = registry.get("urn:stoa:cap:does.not.exist@9.9.9");
    expect(cap).toBeNull();
  });

  it("add() stores file with correct name", () => {
    const cap = makeCap("beta");
    registry.add(cap);
    const path = registry.pathFor("urn:stoa:cap:test.widget.beta@1.0.0");
    expect(existsSync(path)).toBe(true);
    expect(path).toMatch(/test\.widget\.beta@1\.0\.0\.json$/);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Build bundle, then verify it
// ---------------------------------------------------------------------------

describe("buildBundle() + verifyBundle()", () => {
  const DATE = "2026-05-10";
  let bundlePath: string;
  let sigPath: string;

  it("builds a bundle from the caps directory", async () => {
    // Use the real seed caps dir for a richer test
    const seedCapsDir = resolve(process.cwd(), "caps");
    const useCapsDir = existsSync(seedCapsDir) ? seedCapsDir : CAPS_DIR;

    const result = await buildBundle(DATE, useCapsDir, BUNDLES_DIR);

    bundlePath = result.bundlePath;
    sigPath = result.sigPath;

    expect(existsSync(bundlePath)).toBe(true);
    expect(existsSync(sigPath)).toBe(true);
    expect(result.capsCount).toBeGreaterThan(0);
    expect(result.bundleSizeBytes).toBeGreaterThan(100);
    expect(result.manifest.schema_version).toBe("stoa-graph-0.1");
    expect(result.manifest.bundle_version).toBe(DATE);
  }, 30000);

  it("verifies a freshly built bundle", async () => {
    expect(bundlePath).toBeDefined();
    const result = await verifyBundle(bundlePath, sigPath);

    expect(result.hashes_match).toBe(true);
    expect(result.signature_valid).toBe(true);
    expect(result.ok).toBe(true);
  }, 10000);

  it("fails verification when bundle bytes are tampered", async () => {
    expect(bundlePath).toBeDefined();

    // Tamper: write garbage bytes at the end
    const original = readFileSync(bundlePath);
    const tampered = Buffer.concat([original, Buffer.from("TAMPERED")]);
    const tamperedPath = bundlePath + ".tampered.tar.gz";
    writeFileSync(tamperedPath, tampered);

    const result = await verifyBundle(tamperedPath, sigPath);
    expect(result.hashes_match).toBe(false);
    expect(result.ok).toBe(false);

    rmSync(tamperedPath);
  }, 10000);
});

// ---------------------------------------------------------------------------
// 5. Diff bundles
// ---------------------------------------------------------------------------

describe("diffBundles()", () => {
  it("produces a diff bundle with correct metadata", async () => {
    const DATE_A = "2026-05-09";
    const DATE_B = "2026-05-10";

    // Build two bundles: first with alpha only, second with alpha + beta
    const capsA = join(TEST_ROOT, "caps-a");
    const capsB = join(TEST_ROOT, "caps-b");
    mkdirSync(capsA, { recursive: true });
    mkdirSync(capsB, { recursive: true });

    const capA = makeCap("widget-v1");
    const capB = makeCap("widget-v2");

    writeFileSync(
      join(capsA, "test.widget.widget-v1@1.0.0.json"),
      JSON.stringify(capA, null, 2)
    );
    writeFileSync(
      join(capsB, "test.widget.widget-v1@1.0.0.json"),
      JSON.stringify(capA, null, 2)
    );
    writeFileSync(
      join(capsB, "test.widget.widget-v2@1.0.0.json"),
      JSON.stringify(capB, null, 2)
    );

    const resultA = await buildBundle(DATE_A, capsA, BUNDLES_DIR);
    const resultB = await buildBundle(DATE_B, capsB, BUNDLES_DIR);

    const diffResult = await diffBundles(resultA.bundlePath, resultB.bundlePath, BUNDLES_DIR);

    expect(existsSync(diffResult.diffPath)).toBe(true);
    expect(diffResult.addedCount).toBe(1);
    expect(diffResult.removedCount).toBe(0);
    expect(diffResult.modifiedCount).toBe(0);
    expect(diffResult.diffManifest.from_date).toBe(DATE_A);
    expect(diffResult.diffManifest.to_date).toBe(DATE_B);
  }, 30000);
});

// ---------------------------------------------------------------------------
// 6. Semantic search
// ---------------------------------------------------------------------------

describe("Registry.search()", () => {
  it("returns results sorted by cosine similarity", () => {
    const registry = new Registry({ capsDir: CAPS_DIR });

    // Add two caps with deliberately different embeddings
    const cap1 = makeCap("search-x");
    const cap2 = makeCap("search-y");

    registry.add(cap1);
    registry.add(cap2);

    const query = embed("test widget search");
    const results = registry.search(query, 5);

    expect(results.length).toBeGreaterThan(0);
    // Results should be sorted descending by score
    for (let i = 1; i < results.length; i++) {
      expect((results[i - 1]!).score).toBeGreaterThanOrEqual((results[i]!).score);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Zod schema edge cases
// ---------------------------------------------------------------------------

describe("CapabilityNodeSchema", () => {
  it("accepts a fully valid node", () => {
    const cap = makeCap("zod-test");
    const result = CapabilityNodeSchema.safeParse(cap);
    expect(result.success).toBe(true);
  });

  it("rejects empty attestations array", () => {
    const bad = { ...makeCap("zod-no-attest"), attestations: [] };
    const result = CapabilityNodeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects empty privacy_zones array", () => {
    const bad = { ...makeCap("zod-no-zones"), privacy_zones: [] };
    const result = CapabilityNodeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects negative price", () => {
    const bad = {
      ...makeCap("zod-neg-price"),
      price: { oracle: "x402:price-feed-v1", current_cents: -1, stale_after: 300 },
    };
    const result = CapabilityNodeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("accepts price of 0 (free capability)", () => {
    const free = {
      ...makeCap("zod-free"),
      price: { oracle: "x402:price-feed-v1", current_cents: 0, stale_after: 300 },
    };
    const result = CapabilityNodeSchema.safeParse(free);
    expect(result.success).toBe(true);
  });

  it("rejects reliability window_24h > 1", () => {
    const bad = {
      ...makeCap("zod-bad-rel"),
      reliability: {
        window_24h: 1.1,
        p50_latency_ms: 100,
        p95_latency_ms: 300,
        p99_latency_ms: 800,
        samples: 1000,
      },
    };
    const result = CapabilityNodeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
