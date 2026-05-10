# Contributing to stoa-graph

stoa-graph is the reference implementation of the Stoa federated capability registry,
published under Apache-2.0. All contributions are welcome.

## Submitting a capability

The fastest path to getting a capability into the foundation registry is a pull request
adding a JSON file to `caps/`.

### Requirements

1. The file must validate against the Zod schema in `src/types.ts`. Run:
   ```
   npx tsx src/bin/stoa-graph.ts add caps/your-cap.json
   ```
   If it prints "Added: ..." with no errors, the schema is satisfied.

2. The capability must include at least one valid attestation. For self-published
   capabilities, use `kind: "self"` with your vendor DID. A Vext-issued third-party
   attestation (`kind: "third-party:vext.ai"`) is added after conformance review.

3. `privacy_zones` must accurately reflect where the capability can process data.
   PHI-handling capabilities must list only compliant jurisdictions and note the
   BAA requirement in `description`.

4. `compensation` must be set to a real capability URN if an undo path exists,
   or explicitly `null` with `human_confirmation_class: "hard"` for irrevocable actions.

5. Prices declared in `price.current_cents` must be real and kept up to date.
   Stale prices cause agents to over-budget and hurt your reliability score.

### File naming

```
caps/<vendor>.<resource>.<action>@<semver>.json
```

Examples:
- `caps/stripe.charges.create@4.1.0.json`
- `caps/github.pulls.review@1.0.0.json`
- `caps/linear.issues.create@2.0.0.json`

### Pull request checklist

- [ ] Cap file validates cleanly with `stoa-graph add`
- [ ] URN follows `urn:stoa:cap:<vendor>.<resource>.<action>@<semver>` pattern
- [ ] At least one attestation present
- [ ] `privacy_zones` accurately reflects data jurisdiction constraints
- [ ] `compensation` is set or explicitly `null`
- [ ] No real private keys or credentials in any field

## Contributing code

1. Fork the repo.
2. `npm install`
3. `npm test` — all tests must pass.
4. `npm run lint` — no TypeScript errors.
5. Open a pull request. The CI checks schema validity for all caps in `caps/`.

## Governance

stoa-graph is published by Vext Labs as the editor of Stoa v0.1. At the 5-vendor
trigger (five independent vendors achieving L4 conformance), editorial authority and
repository ownership transfer to a neutral foundation. See
[STOA_GOVERNANCE.md](https://github.com/stoa-spec/stoa-spec/blob/main/STOA_GOVERNANCE.md).

Until then, Vext Labs maintains merge authority but commits to:
- Never changing the Apache-2.0 license.
- Never blocking a conformant cap from being listed.
- Publishing all merge decisions with rationale.
