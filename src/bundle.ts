/**
 * Bundle builder — packs a caps/ directory into a daily signed tar.gz bundle.
 *
 * Output layout (inside the tar):
 *   caps/<filename>.json          — individual capability nodes
 *   manifest.json                  — URN → file + content hash + size
 *   embeddings.bin                 — concatenated float32 vectors, row-major
 *   embeddings.idx                 — JSON: { urn: offset_in_bytes }
 *
 * Note: The spec calls for tar.zst (zstandard). For v0, we fall back to tar.gz
 * (gzip) because zstd requires a native binary or a native addon. The format
 * is structurally identical — swap the compressor once zstd is available.
 *
 * TODO: Replace gzip with zstd using the `@bokuweb/zstd-wasm` or `node-zstandard`
 * package once CI confirms native addon builds cleanly. The bundle filename
 * should then change from .tar.gz to .tar.zst per the spec.
 *
 * Production keys: see src/sign.ts.
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import * as tar from "tar";
import { CapabilityNodeSchema, type CapabilityNode, type BundleManifest } from "./types.js";
import { embed, serializeEmbeddings } from "./embed.js";
import { signBundle, type BundleSignature } from "./sign.js";

export interface BundleResult {
  bundlePath: string;
  sigPath: string;
  manifestPath: string;
  capsCount: number;
  bundleSizeBytes: number;
  signature: BundleSignature;
  manifest: BundleManifest;
}

/**
 * Builds a daily signed bundle from the caps directory.
 *
 * @param date     YYYY-MM-DD date string (used in filename + manifest)
 * @param capsDir  Path to directory containing capability JSON files
 * @param outDir   Directory where the bundle and sig will be written
 * @param registry Optional: origin registry URL for the manifest
 */
export async function buildBundle(
  date: string,
  capsDir: string,
  outDir: string,
  registry = "caps.stoa.foundation"
): Promise<BundleResult> {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // 1. Read all capability files
  const capFiles = readdirSync(capsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const caps: Array<{ node: CapabilityNode; filename: string; raw: Buffer }> = [];

  for (const filename of capFiles) {
    const filePath = join(capsDir, filename);
    const rawBuf = readFileSync(filePath);
    try {
      const parsed = JSON.parse(rawBuf.toString("utf8")) as Record<string, unknown>;

      // Auto-generate embeddings for caps that have an empty or missing embedding.
      // This allows seed JSON files to store `"embedding": []` as a placeholder.
      if (!Array.isArray(parsed["embedding"]) || (parsed["embedding"] as unknown[]).length !== 768) {
        const text = [
          (parsed["summary"] as string | undefined) ?? "",
          (parsed["description"] as string | undefined) ?? "",
          (parsed["urn"] as string | undefined) ?? filename,
        ]
          .join(" ")
          .trim();
        parsed["embedding"] = embed(text);
      }

      const node = CapabilityNodeSchema.parse(parsed);
      // Re-serialize with the filled embedding for consistent hashing
      const serialized = Buffer.from(JSON.stringify(node, null, 2), "utf8");
      caps.push({ node, filename, raw: serialized });
    } catch (err) {
      console.warn(`[bundle] Skipping malformed cap ${filename}: ${err}`);
    }
  }

  if (caps.length === 0) {
    throw new Error(`No valid capabilities found in ${capsDir}`);
  }

  // 2. Generate embeddings binary + index
  const embeddings = caps.map((c) => c.node.embedding);
  const embBuf = serializeEmbeddings(embeddings);

  // Index: URN → byte offset in embeddings.bin
  const embIdx: Record<string, number> = {};
  caps.forEach((c, i) => {
    embIdx[c.node.urn] = i * 768 * 4; // each vector is 768 float32 = 3072 bytes
  });

  const embIdxBuf = Buffer.from(JSON.stringify(embIdx, null, 2), "utf8");

  // 3. Build manifest
  const entries = caps.map((c) => ({
    urn: c.node.urn,
    file: `caps/${c.filename}`,
    content_hash: `sha256:${createHash("sha256").update(c.raw).digest("hex")}`,
    size_bytes: c.raw.length,
  }));

  const manifest: BundleManifest = {
    bundle_version: date,
    generated_at: new Date().toISOString(),
    registry,
    caps_count: caps.length,
    entries,
    embeddings_bin: "embeddings.bin",
    embeddings_idx: "embeddings.idx",
    previous_bundle: null,
    schema_version: "stoa-graph-0.1",
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");

  // 4. Write temporary files for tar packing
  const tmpDir = join(outDir, `.tmp-${date}`);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(join(tmpDir, "caps"), { recursive: true });

  for (const c of caps) {
    writeFileSync(join(tmpDir, "caps", c.filename), c.raw);
  }
  writeFileSync(join(tmpDir, "manifest.json"), manifestBuf);
  writeFileSync(join(tmpDir, "embeddings.bin"), embBuf);
  writeFileSync(join(tmpDir, "embeddings.idx"), embIdxBuf);

  // 5. Create tar.gz (see TODO above for zstd upgrade)
  const bundleFilename = `caps-${date}.tar.gz`;
  const bundlePath = join(outDir, bundleFilename);

  await tar.create(
    {
      gzip: true,
      file: bundlePath,
      cwd: tmpDir,
    },
    ["caps", "manifest.json", "embeddings.bin", "embeddings.idx"]
  );

  // 6. Sign the bundle
  const bundleBytes = readFileSync(bundlePath);
  const signature = await signBundle(bundleBytes, date);

  const sigPath = bundlePath + ".sig";
  writeFileSync(sigPath, JSON.stringify(signature, null, 2), "utf8");

  // 7. Also write manifest alongside bundle for quick inspection
  const manifestPath = join(outDir, `manifest-${date}.json`);
  writeFileSync(manifestPath, manifestBuf);

  // 8. Cleanup temp dir
  const { rmSync } = await import("node:fs");
  rmSync(tmpDir, { recursive: true, force: true });

  return {
    bundlePath,
    sigPath,
    manifestPath,
    capsCount: caps.length,
    bundleSizeBytes: bundleBytes.length,
    signature,
    manifest,
  };
}
