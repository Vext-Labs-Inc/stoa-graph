/**
 * Deterministic pseudo-embedding for capability nodes.
 *
 * v0 implementation: SHA-256 of (summary + " " + description), then expand
 * the 32-byte hash to a 768-float32 vector in [-1, 1] using a seeded LCG.
 * The resulting vector is L2-normalized.
 *
 * This is deterministic, reproducible, and sufficient for cosine-similarity
 * search in tests and local demos. It is NOT semantically meaningful — two
 * capabilities with similar text will NOT necessarily have similar embeddings.
 *
 * TODO: Replace with real embeddings using @xenova/transformers +
 * BAAI/bge-small-en-v1.5 (768-d, Apache-2.0). The API surface is intentionally
 * identical so the swap is a single-file change:
 *   import { pipeline } from "@xenova/transformers";
 *   const extractor = await pipeline("feature-extraction", "BAAI/bge-small-en-v1.5");
 *   const result = await extractor(text, { pooling: "mean", normalize: true });
 *   return Array.from(result.data) as number[];
 *
 * Production keys are managed separately (see SIGNING.md).
 */

import { createHash } from "node:crypto";

const EMBEDDING_DIM = 768;

/**
 * Generates a 768-dimensional deterministic pseudo-embedding for the given text.
 * Uses SHA-256 of the text as a seed, then expands via a 32-bit Lehmer LCG
 * (multiplier 1664525, increment 1013904223 — Numerical Recipes constants).
 *
 * The vector is L2-normalized so cosine similarity behaves correctly.
 */
export function embed(text: string): number[] {
  // 1. SHA-256 of text → 32 bytes → 8 uint32 seeds
  const hashBytes = createHash("sha256").update(text, "utf8").digest();

  // Seed the LCG from the 8 uint32s from the hash
  const seeds: number[] = [];
  for (let i = 0; i < 8; i++) {
    seeds.push(hashBytes.readUInt32BE(i * 4));
  }

  // 2. Generate EMBEDDING_DIM floats in [0, 1) using a Lehmer LCG seeded
  //    round-robin from our 8 uint32 seeds.
  const raw: number[] = new Array(EMBEDDING_DIM);
  let lcgState = seeds[0] ?? 1; // fallback to 1 if somehow undefined

  for (let i = 0; i < EMBEDDING_DIM; i++) {
    // Absorb one seed every 96 dimensions to mix in all hash bytes
    if (i > 0 && i % 96 === 0) {
      const seedIdx = Math.floor(i / 96) % seeds.length;
      lcgState = (lcgState ^ (seeds[seedIdx] ?? 0)) >>> 0;
    }

    // 32-bit LCG step
    lcgState = Math.imul(lcgState, 1664525) + 1013904223;
    lcgState = lcgState >>> 0; // keep as uint32

    // Map to [-1, 1]
    raw[i] = (lcgState / 0xffffffff) * 2 - 1;
  }

  // 3. L2-normalize
  let norm = 0;
  for (const v of raw) {
    norm += v * v;
  }
  norm = Math.sqrt(norm);

  if (norm === 0) {
    // Degenerate case — return unit vector along first dimension
    const unit = new Array(EMBEDDING_DIM).fill(0) as number[];
    unit[0] = 1;
    return unit;
  }

  return raw.map((v) => v / norm);
}

/**
 * Cosine similarity between two 768-d vectors.
 * Returns a value in [-1, 1]; higher = more similar.
 */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize a list of embedding vectors to a flat Float32 binary buffer.
 * Layout: [v0_f0, v0_f1, ..., v0_f767, v1_f0, ..., vN_f767]
 * Each float is 4 bytes little-endian IEEE 754.
 */
export function serializeEmbeddings(embeddings: number[][]): Buffer {
  const count = embeddings.length;
  const buf = Buffer.allocUnsafe(count * EMBEDDING_DIM * 4);
  let offset = 0;
  for (const vec of embeddings) {
    for (const v of vec) {
      buf.writeFloatLE(v, offset);
      offset += 4;
    }
  }
  return buf;
}
