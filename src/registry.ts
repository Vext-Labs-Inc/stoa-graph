/**
 * Registry — filesystem-backed capability store.
 *
 * Capabilities are stored as individual JSON files under a configurable
 * directory (default: <cwd>/caps/).
 *
 * File naming: URN slugified by replacing the `urn:stoa:cap:` prefix and
 * preserving the `@semver` suffix.
 *
 * Example:
 *   urn:stoa:cap:hubspot.contacts.create@2.3.1
 *   → caps/hubspot.contacts.create@2.3.1.json
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CapabilityNodeSchema, type CapabilityNode } from "./types.js";
import { embed } from "./embed.js";

export interface RegistryOptions {
  /** Directory where capability JSON files are stored. Defaults to <cwd>/caps */
  capsDir?: string;
  /** If true, auto-generate embeddings for caps that lack them. Default: true */
  autoEmbed?: boolean;
}

function urnToFilename(urn: string): string {
  // urn:stoa:cap:hubspot.contacts.create@2.3.1 → hubspot.contacts.create@2.3.1.json
  const withoutPrefix = urn.replace(/^urn:stoa:cap:/, "");
  return `${withoutPrefix}.json`;
}

export class Registry {
  private readonly capsDir: string;
  private readonly autoEmbed: boolean;

  constructor(options: RegistryOptions = {}) {
    this.capsDir = resolve(options.capsDir ?? join(process.cwd(), "caps"));
    this.autoEmbed = options.autoEmbed ?? true;

    if (!existsSync(this.capsDir)) {
      mkdirSync(this.capsDir, { recursive: true });
    }
  }

  /**
   * Validates a capability node against the Zod schema.
   * Returns a list of validation error messages, or empty array if valid.
   */
  validate(cap: unknown): string[] {
    const result = CapabilityNodeSchema.safeParse(cap);
    if (result.success) return [];
    return result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
  }

  /**
   * Adds a capability to the registry.
   *
   * - Validates against schema (throws on failure).
   * - Auto-generates a 768-d embedding if missing or wrong length (when autoEmbed=true).
   * - Writes to <capsDir>/<slug>.json.
   * - Returns the final canonical CapabilityNode.
   */
  add(cap: unknown): CapabilityNode {
    const errors = this.validate(cap);
    if (errors.length > 0) {
      throw new Error(`Capability validation failed:\n${errors.join("\n")}`);
    }

    const parsed = CapabilityNodeSchema.parse(cap);

    // Auto-embed if needed
    if (this.autoEmbed && (!parsed.embedding || parsed.embedding.length !== 768)) {
      const text = [parsed.summary ?? "", parsed.description ?? "", parsed.urn].join(" ").trim();
      (parsed as { embedding: number[] }).embedding = embed(text);
    }

    const filePath = join(this.capsDir, urnToFilename(parsed.urn));
    writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf8");

    return parsed;
  }

  /**
   * Returns all capabilities in the registry, sorted by URN.
   */
  list(): CapabilityNode[] {
    if (!existsSync(this.capsDir)) return [];

    const caps: CapabilityNode[] = [];
    for (const f of readdirSync(this.capsDir).sort()) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(this.capsDir, f), "utf8");
        caps.push(CapabilityNodeSchema.parse(JSON.parse(raw)));
      } catch (err) {
        console.warn(`[registry] Skipping malformed cap file ${f}: ${err}`);
      }
    }
    return caps;
  }

  /**
   * Returns a single capability by URN, or null if not found.
   */
  get(urn: string): CapabilityNode | null {
    const filePath = join(this.capsDir, urnToFilename(urn));
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf8");
      return CapabilityNodeSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Returns the filesystem path for a given URN.
   */
  pathFor(urn: string): string {
    return join(this.capsDir, urnToFilename(urn));
  }

  /**
   * Removes a capability from the registry.
   * Returns true if it existed and was deleted, false if not found.
   */
  remove(urn: string): boolean {
    const filePath = join(this.capsDir, urnToFilename(urn));
    if (!existsSync(filePath)) return false;
    try {
      unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Semantic search over the registry using cosine similarity.
   * Assumes all stored embeddings are L2-normalized (embed() guarantees this).
   *
   * @param queryEmbedding 768-d query vector (should be L2-normalized)
   * @param topK number of results to return
   */
  search(queryEmbedding: number[], topK = 10): Array<{ cap: CapabilityNode; score: number }> {
    const caps = this.list();
    const scored = caps.map((cap) => {
      // Dot product of two L2-normalized vectors == cosine similarity
      let dot = 0;
      for (let i = 0; i < 768; i++) {
        dot += (cap.embedding[i] ?? 0) * (queryEmbedding[i] ?? 0);
      }
      return { cap, score: dot };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  get capsDirPath(): string {
    return this.capsDir;
  }
}
