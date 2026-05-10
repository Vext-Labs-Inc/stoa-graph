# stoa-graph

**The federated capability registry for Stoa** — daily signed bundles, URN-keyed nodes, offline-first semantic search.

Part of the [Stoa open substrate](https://github.com/stoa-spec/stoa-spec) for agent-readable SaaS.
License: Apache-2.0. Spec: CC-BY-4.0.

---

## What this is

stoa-graph is the reference implementation of the Stoa capability registry (STOA.md §7).
Every capability that an agent can call is a node in this graph:

```jsonc
{
  "urn": "urn:stoa:cap:hubspot.contacts.create@2.3.1",
  "vendor_did": "did:web:hubspot.com",
  "schema": { "input_ref": "...", "output_ref": "..." },
  "embedding": [0.012, -0.034, ...],   // 768-d, for NL search
  "attestations": [{ "by": "did:web:vext.ai", "kind": "third-party:vext.ai", "sig": "..." }],
  "price": { "current_cents": 8, "stale_after": 300 },
  "reliability": { "window_24h": 0.997, "p50_latency_ms": 84 },
  "privacy_zones": ["US", "EU"],
  "compensation": "urn:stoa:cap:hubspot.contacts.delete@2.3.1",
  "side_effect_class": "external.crm.write",
  "scopes_required": ["hubspot:contacts:write"],
  "deprecation": null
}
```

The registry is:
- **Federated** — no central gatekeeper. Anyone can run their own registry.
- **Signed** — every daily bundle is ES256-signed; consumers verify before loading.
- **Offline-first** — a 5MB bundle gives you the full graph locally. Agents plan with zero network round-trips.
- **Semantic** — 768-d embeddings support cosine-similarity search for natural-language capability discovery.

The Vext-run foundation registry is at `caps.stoa.foundation` (CNAME pending; placeholder active).

---

## This repo contains

- `src/` — TypeScript library (types, registry, bundle, diff, sign, verify, embed)
- `bin/stoa-graph.ts` — CLI (add, list, publish, verify, diff)
- `caps/` — Seed capabilities: 9 Theron specialists + 1 HubSpot sample
- `tests/` — vitest integration suite

---

## Seed capabilities

| URN | Description | Price |
|-----|-------------|-------|
| `urn:stoa:cap:vext.cyber.scan@1.0.0` | Theron-Cyber vulnerability scan | $0.50/req + $5/finding |
| `urn:stoa:cap:vext.cyber.report@1.0.0` | Theron-Cyber pentest report | $50/report |
| `urn:stoa:cap:vext.code.review@1.0.0` | Theron-Code per-file review | $0.10/file |
| `urn:stoa:cap:vext.code.refactor@1.0.0` | Theron-Code refactor with diff output | $1.00/refactor |
| `urn:stoa:cap:vext.legal.review@1.0.0` | Theron-Legal contract review | $5.00/contract |
| `urn:stoa:cap:vext.medical.review@1.0.0` | Theron-Medical chart review (HIPAA, US-only) | $10.00/chart |
| `urn:stoa:cap:vext.council.synthesize@1.0.0` | Full 30-specialist council synthesis | $0.10/1K in + $0.40/1K out |
| `urn:stoa:cap:vext.research.search@1.0.0` | Citation-grounded research | $0.20/query |
| `urn:stoa:cap:vext.classify.intent@1.0.0` | Ultra-low-latency intent routing | $0.001/req |
| `urn:stoa:cap:hubspot.contacts.create@2.3.1` | HubSpot contact creation (sample) | $0.08/req |

---

## CLI

```bash
npm install
npm run build

# Add a capability
npx stoa-graph add caps/my-cap.json

# List all capabilities
npx stoa-graph list

# Build + sign the daily bundle
npx stoa-graph publish 2026-05-10

# Verify a bundle
npx stoa-graph verify bundles/caps-2026-05-10.tar.gz

# Diff two bundles
npx stoa-graph diff 2026-05-09 2026-05-10
```

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `STOA_CAPS_DIR` | `./caps` | Capability JSON directory |
| `STOA_BUNDLES_DIR` | `./bundles` | Bundle output directory |
| `STOA_SIGNING_KEY_JWK` | (dev key) | EC P-256 private key as JSON JWK |
| `STOA_SIGNER_DID` | `did:web:vext.ai` | DID of the signing entity |

---

## Library API

```typescript
import {
  Registry,
  buildBundle,
  verifyBundle,
  diffBundles,
  embed,
  cosineSim,
  CapabilityNodeSchema,
} from "@vext-labs/stoa-graph";

// Registry
const registry = new Registry({ capsDir: "./caps" });
registry.add(capJson);                          // validate + write
const caps = registry.list();                   // all caps
const cap = registry.get("urn:stoa:cap:...");  // by URN
registry.search(embed("find me a CRM write capability"), 5);

// Daily bundle
const result = await buildBundle("2026-05-10", "./caps", "./bundles");
// result.bundlePath, result.sigPath, result.manifest

// Verify
const vr = await verifyBundle("bundles/caps-2026-05-10.tar.gz");
// vr.ok, vr.hashes_match, vr.signature_valid

// Diff
const dr = await diffBundles(
  "bundles/caps-2026-05-09.tar.gz",
  "bundles/caps-2026-05-10.tar.gz",
  "./bundles"
);
// dr.addedCount, dr.removedCount, dr.modifiedCount

// Embeddings
const vec = embed("vulnerability scan capability");  // 768-d deterministic
const sim = cosineSim(vec, anotherVec);              // cosine similarity
```

---

## Running your own registry

1. Fork this repo.
2. Replace the `caps/` directory with your capabilities.
3. Generate your signing key:
   ```bash
   node -e "
   const { generateKeyPairSync } = require('crypto');
   const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
   const { exportJWK } = require('jose');
   exportJWK(privateKey).then(k => { k.alg='ES256'; k.use='sig'; console.log(JSON.stringify(k)); });
   "
   ```
4. Set `STOA_SIGNING_KEY_JWK` and `STOA_SIGNER_DID` in your environment.
5. Run `stoa-graph publish $(date +%Y-%m-%d)` in a daily cron.
6. Serve the `bundles/` directory over HTTPS.
7. Announce your registry URL by opening a PR to the [Stoa Foundation registry list](https://github.com/stoa-spec/stoa-spec).

### URN resolution across registries

If your capability URN conflicts with one in another registry, agents resolve by attestation
strength (foundation > third-party > self). To get a foundation attestation, submit to the
[Stoa conformance suite](https://github.com/stoa-spec/stoa-conformance).

---

## Bundle format

Each daily bundle is a `tar.gz` (v0; `tar.zst` upgrade planned for v0.2):

```
caps/
  hubspot.contacts.create@2.3.1.json
  vext.cyber.scan@1.0.0.json
  ...
manifest.json          # URN → file, content_hash, size_bytes
embeddings.bin         # flat float32 array, 768 floats per cap, row-major
embeddings.idx         # JSON: { "urn": byte_offset_in_embeddings_bin }
```

The `.sig` file alongside the bundle is a JSON object containing:
- `alg`: `ES256`
- `bundle_hash`: `sha256:<hex>` of the bundle bytes
- `jws`: compact JWS whose payload encodes the bundle hash and signer DID
- `public_key`: public key JWK for offline verification
- `signer`: DID of the signer
- `signed_at`: ISO-8601 timestamp

---

## Tests

```bash
npm install
npm test
```

All tests are in `tests/bundle.test.ts` using vitest. No network access required.

---

## Roadmap

- v0.2: `tar.zst` bundles (replacing gzip); DID document resolution in verify
- v0.3: Real 768-d embeddings via `@xenova/transformers` BAAI/bge-small-en-v1.5
- v0.4: Merkle tree anchoring (Sigstore Rekor-style) for daily roots
- v1.0: Foundation handoff at 5 independently-conformant vendors

---

## Links

- Stoa spec: https://github.com/stoa-spec/stoa-spec
- Conformance suite: https://github.com/stoa-spec/stoa-conformance
- Foundation registry: https://caps.stoa.foundation (CNAME pending)
- Vext Labs: https://tryvext.com
