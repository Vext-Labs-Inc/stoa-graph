#!/usr/bin/env node
/**
 * stoa-graph CLI
 *
 * Commands:
 *   add <cap.json>                Add a capability to the registry
 *   list                          List all capabilities in the registry
 *   publish <date>                Build + sign the daily bundle for <date> (YYYY-MM-DD)
 *   verify <bundle> [--sig <f>]   Verify a bundle's signature and hash integrity
 *   diff <date-from> <date-to>    Emit a diff bundle between two dated bundles
 *
 * Environment:
 *   STOA_CAPS_DIR       Directory of capability JSON files (default: ./caps)
 *   STOA_BUNDLES_DIR    Directory for output bundles (default: ./bundles)
 *   STOA_SIGNING_KEY_JWK  Private EC P-256 key as JSON JWK (see SIGNING.md)
 *   STOA_SIGNER_DID     DID of the signing entity (default: did:web:vext.ai)
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Registry } from "../registry.js";
import { buildBundle } from "../bundle.js";
import { verifyBundle } from "../verify.js";
import { diffBundles } from "../diff.js";

const program = new Command();

program
  .name("stoa-graph")
  .description("Federated capability registry for the Stoa open substrate")
  .version("0.1.0");

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

program
  .command("add <capFile>")
  .description("Add a capability JSON file to the registry")
  .option("--caps-dir <dir>", "Caps directory", process.env["STOA_CAPS_DIR"] ?? "./caps")
  .action(async (capFile: string, opts: { capsDir: string }) => {
    const capPath = resolve(capFile);
    let raw: string;
    try {
      raw = readFileSync(capPath, "utf8");
    } catch {
      console.error(`Error: Cannot read file: ${capPath}`);
      process.exit(1);
    }

    let capData: unknown;
    try {
      capData = JSON.parse(raw);
    } catch {
      console.error("Error: File is not valid JSON");
      process.exit(1);
    }

    const registry = new Registry({ capsDir: opts.capsDir });
    const errors = registry.validate(capData);

    if (errors.length > 0) {
      console.error("Capability validation failed:");
      for (const e of errors) {
        console.error(`  - ${e}`);
      }
      process.exit(1);
    }

    try {
      const cap = registry.add(capData);
      console.log(`Added: ${cap.urn}`);
      console.log(`File:  ${registry.pathFor(cap.urn)}`);
    } catch (err) {
      console.error(`Error adding capability: ${err}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

program
  .command("list")
  .description("List all capabilities in the registry")
  .option("--caps-dir <dir>", "Caps directory", process.env["STOA_CAPS_DIR"] ?? "./caps")
  .option("--json", "Output as JSON array")
  .action((opts: { capsDir: string; json: boolean }) => {
    const registry = new Registry({ capsDir: opts.capsDir });
    const caps = registry.list();

    if (opts.json) {
      console.log(JSON.stringify(caps, null, 2));
      return;
    }

    if (caps.length === 0) {
      console.log("No capabilities found.");
      return;
    }

    console.log(`\n${caps.length} capability/capabilities in ${opts.capsDir}:\n`);
    for (const cap of caps) {
      const price = cap.price.current_cents;
      const priceStr = price < 1 ? `$${(price / 100).toFixed(4)}` : `$${(price / 100).toFixed(2)}`;
      const rel = cap.reliability.window_24h.toFixed(3);
      console.log(
        `  ${cap.urn}`
      );
      console.log(
        `    ${cap.summary ?? "(no summary)"} | price: ${priceStr}/req | reliability: ${rel} | zones: ${cap.privacy_zones.join(", ")}`
      );
    }
    console.log();
  });

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

program
  .command("publish <date>")
  .description("Build and sign the daily bundle for <date> (YYYY-MM-DD)")
  .option("--caps-dir <dir>", "Caps directory", process.env["STOA_CAPS_DIR"] ?? "./caps")
  .option("--out-dir <dir>", "Output directory", process.env["STOA_BUNDLES_DIR"] ?? "./bundles")
  .option("--registry <name>", "Registry origin name", "caps.stoa.foundation")
  .action(async (date: string, opts: { capsDir: string; outDir: string; registry: string }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error("Error: date must be YYYY-MM-DD");
      process.exit(1);
    }

    console.log(`Building bundle for ${date}...`);

    try {
      const result = await buildBundle(date, opts.capsDir, opts.outDir, opts.registry);
      console.log(`\nBundle built successfully:`);
      console.log(`  File:     ${result.bundlePath}`);
      console.log(`  Sig:      ${result.sigPath}`);
      console.log(`  Manifest: ${result.manifestPath}`);
      console.log(`  Caps:     ${result.capsCount}`);
      console.log(`  Size:     ${(result.bundleSizeBytes / 1024).toFixed(1)} KB`);
      console.log(`  Signer:   ${result.signature.signer}`);
      if (result.signature.dev_only) {
        console.warn(
          "\n  WARNING: Signed with a dev-only throwaway key. " +
            "Set STOA_SIGNING_KEY_JWK for production."
        );
      }
    } catch (err) {
      console.error(`Error building bundle: ${err}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

program
  .command("verify <bundlePath>")
  .description("Verify a bundle's signature and hash integrity")
  .option("--sig <sigPath>", "Path to .sig file (defaults to <bundle>.sig)")
  .action(async (bundlePath: string, opts: { sig?: string }) => {
    console.log(`Verifying ${bundlePath}...`);

    const result = await verifyBundle(bundlePath, opts.sig);

    console.log(`\nVerification result:`);
    console.log(`  Status:           ${result.ok ? "PASS" : "FAIL"}`);
    console.log(`  Hashes match:     ${result.hashes_match}`);
    console.log(`  Signature valid:  ${result.signature_valid}`);
    console.log(`  Computed hash:    ${result.computed_hash}`);
    console.log(`  Declared hash:    ${result.declared_hash}`);
    console.log(`  Signer:           ${result.signer}`);
    console.log(`  Signed at:        ${result.signed_at}`);
    if (result.dev_only) {
      console.warn("  WARNING: Signed with a dev-only key (not production trust root)");
    }
    if (result.error && !result.ok) {
      console.error(`  Error:            ${result.error}`);
    }

    process.exit(result.ok ? 0 : 1);
  });

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

program
  .command("diff <dateFrom> <dateTo>")
  .description("Emit a diff bundle between two dated bundles")
  .option("--bundles-dir <dir>", "Directory containing bundles", process.env["STOA_BUNDLES_DIR"] ?? "./bundles")
  .option("--out-dir <dir>", "Output directory for diff bundle (defaults to --bundles-dir)")
  .action(
    async (
      dateFrom: string,
      dateTo: string,
      opts: { bundlesDir: string; outDir?: string }
    ) => {
      const bundlesDir = resolve(opts.bundlesDir);
      const outDir = resolve(opts.outDir ?? bundlesDir);

      const prevPath = join(bundlesDir, `caps-${dateFrom}.tar.gz`);
      const nextPath = join(bundlesDir, `caps-${dateTo}.tar.gz`);

      console.log(`Diffing ${dateFrom} → ${dateTo}...`);

      try {
        const result = await diffBundles(prevPath, nextPath, outDir);
        console.log(`\nDiff bundle built:`);
        console.log(`  File:     ${result.diffPath}`);
        console.log(`  Sig:      ${result.sigPath}`);
        console.log(`  Added:    ${result.addedCount}`);
        console.log(`  Removed:  ${result.removedCount}`);
        console.log(`  Modified: ${result.modifiedCount}`);
        console.log(`  Unchanged: ${result.diffManifest.unchanged_count}`);
      } catch (err) {
        console.error(`Error building diff: ${err}`);
        process.exit(1);
      }
    }
  );

program.parse();
