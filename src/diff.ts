/**
 * Bundle diff — computes the delta between two daily bundles.
 *
 * The diff bundle is a tar.gz containing only the changed/added capability files
 * plus a diff manifest describing what changed (added, removed, modified).
 *
 * Consumers download the full bundle once, then daily diff patches (~80KB typical).
 * The diff bundle is self-contained: it includes all new/modified caps so the
 * consumer can apply it without re-downloading the base bundle.
 *
 * Format:
 *   caps/<filename>.json         — new or modified caps
 *   manifest-diff.json           — diff manifest (see DiffManifest type)
 *   embeddings-diff.bin          — embeddings for new/modified caps only
 *   embeddings-diff.idx          — index for embeddings-diff.bin
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import * as tar from "tar";
import { CapabilityNodeSchema, type CapabilityNode } from "./types.js";
import { serializeEmbeddings } from "./embed.js";
import { signBundle } from "./sign.js";

export interface DiffManifest {
  schema_version: "stoa-graph-0.1";
  from_date: string;
  to_date: string;
  generated_at: string;
  added: string[];
  removed: string[];
  modified: string[];
  unchanged_count: number;
}

export interface DiffResult {
  diffPath: string;
  sigPath: string;
  diffManifest: DiffManifest;
  addedCount: number;
  removedCount: number;
  modifiedCount: number;
}

/**
 * Extract cap files from a bundle (tar.gz) into a temporary directory.
 * Returns a map of filename → { raw: Buffer, hash: string }.
 */
async function extractBundle(
  bundlePath: string,
  tmpDir: string
): Promise<Map<string, { raw: Buffer; hash: string }>> {
  mkdirSync(tmpDir, { recursive: true });

  await tar.extract({
    file: bundlePath,
    cwd: tmpDir,
    filter: (path) => path.startsWith("caps/") && path.endsWith(".json"),
  });

  const result = new Map<string, { raw: Buffer; hash: string }>();
  const capsDir = join(tmpDir, "caps");
  if (!existsSync(capsDir)) return result;

  for (const f of readdirSync(capsDir)) {
    if (!f.endsWith(".json")) continue;
    const raw = readFileSync(join(capsDir, f));
    const hash = createHash("sha256").update(raw).digest("hex");
    result.set(f, { raw, hash });
  }

  return result;
}

/**
 * Computes and writes a diff bundle between two daily bundles.
 *
 * @param prevBundlePath  Path to the previous full bundle (e.g. caps-2026-05-09.tar.gz)
 * @param nextBundlePath  Path to the next full bundle (e.g. caps-2026-05-10.tar.gz)
 * @param outDir          Directory where diff bundle will be written
 */
export async function diffBundles(
  prevBundlePath: string,
  nextBundlePath: string,
  outDir: string
): Promise<DiffResult> {
  if (!existsSync(prevBundlePath)) {
    throw new Error(`Previous bundle not found: ${prevBundlePath}`);
  }
  if (!existsSync(nextBundlePath)) {
    throw new Error(`Next bundle not found: ${nextBundlePath}`);
  }

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Derive dates from filenames (caps-YYYY-MM-DD.tar.gz)
  const prevDate = prevBundlePath.match(/caps-(\d{4}-\d{2}-\d{2})/)?.[1] ?? "unknown";
  const nextDate = nextBundlePath.match(/caps-(\d{4}-\d{2}-\d{2})/)?.[1] ?? "unknown";

  const tmpPrev = join(outDir, `.tmp-diff-prev-${Date.now()}`);
  const tmpNext = join(outDir, `.tmp-diff-next-${Date.now()}`);

  try {
    const prevCaps = await extractBundle(prevBundlePath, tmpPrev);
    const nextCaps = await extractBundle(nextBundlePath, tmpNext);

    // Compute diff sets
    const prevKeys = new Set(prevCaps.keys());
    const nextKeys = new Set(nextCaps.keys());

    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];

    for (const [key, nextEntry] of nextCaps) {
      if (!prevKeys.has(key)) {
        added.push(key);
      } else {
        const prevEntry = prevCaps.get(key)!;
        if (prevEntry.hash !== nextEntry.hash) {
          modified.push(key);
        } else {
          unchanged.push(key);
        }
      }
    }

    for (const key of prevKeys) {
      if (!nextKeys.has(key)) {
        removed.push(key);
      }
    }

    // Build diff bundle
    const tmpDiff = join(outDir, `.tmp-diff-build-${Date.now()}`);
    mkdirSync(join(tmpDiff, "caps"), { recursive: true });

    // Include all new + modified caps
    const changedCaps: Array<{ node: CapabilityNode; raw: Buffer }> = [];
    for (const key of [...added, ...modified]) {
      const entry = nextCaps.get(key)!;
      writeFileSync(join(tmpDiff, "caps", key), entry.raw);
      try {
        const node = CapabilityNodeSchema.parse(JSON.parse(entry.raw.toString("utf8")));
        changedCaps.push({ node, raw: entry.raw });
      } catch {
        // Skip malformed
      }
    }

    // Embeddings for changed caps
    const embBuf = serializeEmbeddings(changedCaps.map((c) => c.node.embedding));
    const embIdx: Record<string, number> = {};
    changedCaps.forEach((c, i) => {
      embIdx[c.node.urn] = i * 768 * 4;
    });

    writeFileSync(join(tmpDiff, "embeddings-diff.bin"), embBuf);
    writeFileSync(join(tmpDiff, "embeddings-diff.idx"), JSON.stringify(embIdx, null, 2));

    const diffManifest: DiffManifest = {
      schema_version: "stoa-graph-0.1",
      from_date: prevDate,
      to_date: nextDate,
      generated_at: new Date().toISOString(),
      added: added.map((f) => `urn:stoa:cap:${f.replace(/\.json$/, "")}`),
      removed: removed.map((f) => `urn:stoa:cap:${f.replace(/\.json$/, "")}`),
      modified: modified.map((f) => `urn:stoa:cap:${f.replace(/\.json$/, "")}`),
      unchanged_count: unchanged.length,
    };

    writeFileSync(join(tmpDiff, "manifest-diff.json"), JSON.stringify(diffManifest, null, 2));

    const diffFilename = `diff-from-${prevDate}-to-${nextDate}.tar.gz`;
    const diffPath = join(outDir, diffFilename);

    const entries: string[] = ["manifest-diff.json", "embeddings-diff.bin", "embeddings-diff.idx"];
    if (existsSync(join(tmpDiff, "caps")) && changedCaps.length > 0) {
      entries.push("caps");
    }

    await tar.create({ gzip: true, file: diffPath, cwd: tmpDiff }, entries);

    // Sign
    const diffBytes = readFileSync(diffPath);
    const signature = await signBundle(diffBytes, `${prevDate}-to-${nextDate}`);
    const sigPath = diffPath + ".sig";
    writeFileSync(sigPath, JSON.stringify(signature, null, 2));

    // Cleanup temp dirs
    const { rmSync } = await import("node:fs");
    rmSync(tmpPrev, { recursive: true, force: true });
    rmSync(tmpNext, { recursive: true, force: true });
    rmSync(tmpDiff, { recursive: true, force: true });

    return {
      diffPath,
      sigPath,
      diffManifest,
      addedCount: added.length,
      removedCount: removed.length,
      modifiedCount: modified.length,
    };
  } catch (err) {
    // Cleanup on error
    const { rmSync } = await import("node:fs");
    [tmpPrev, tmpNext].forEach((d) => {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    });
    throw err;
  }
}
