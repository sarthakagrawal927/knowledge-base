---
title: Local document workflow and storage isolation qualification
description: Synthetic authenticated handler proof, immediate shared-object deletion mitigation, and retained isolation and live gates.
---

# Local document workflow qualification — 2026-09-07

Knowledge Base is private shared retrieval infrastructure. The dashboard requires
Cloudflare Access and the Worker requires service credentials. There is no
supported anonymous document-import/search journey. The dashboard currently
lists files/chunks; this qualification uses the supported Worker handlers and
does not add a dashboard document viewer or deletion interface.

## Actual local route proof

The new case in `cloudflare/worker/tests/app.test.ts` uploads the synthetic text
file `synthetic-manual.txt` as multipart data, runs inline ingestion, queries the
corpus, and checks a citation's exact file ID, page 1 and verbatim excerpt. A new
app handler instance reopens the file metadata against the same fixture storage.
Sole-owner deletion removes the raw object and vectors; file/artifact lookups
then return404 and lexical search returns no results. Missing credentials return
401 and another tenant cannot inspect the file or its parse artifact.

The synthetic document is: “Synthetic heliotrope manual: the recovery code is
violet-lantern.” It contains no user or customer information.

The test uses actual Hono routes, auth, parser, ingestion, lexical retrieval,
extractive answer/citation and deletion logic. Metadata/RAG repositories, R2,
Vectorize and AI/embeddings are deterministic local fixtures. Handler recreation
is not proof of deployed D1 durability. No live provider or retrieval-quality
claim follows from this test.

```sh
cd cloudflare/worker
pnpm exec vitest run tests/app.test.ts -t 'qualifies synthetic|preserves another tenant'
pnpm exec vitest run tests/file-storage.test.ts
pnpm check
```

## Reproduced defect and immediate mitigation

Two tenants imported identical content into the same domain. Both file records
referenced `raw/<domain>/<contentHash>`. Deleting tenant A's file returned200
and removed tenant B's raw data. Parse artifacts are also globally keyed by
content hash, including across domains. The regression failed because B's
stored object was gone.

Deletion now checks for other file records outside the requested deletion set
with the same raw key or content hash. A conflict returns409 `shared_file_storage`
before touching vectors, metadata or R2. Both single-file and source-set deletion
use this guard. No foreign file IDs or tenant names are disclosed. A separate
Node SQLite test executes the actual repository preflight SQL against synthetic
rows, including shared raw keys, shared hashes, whole-set deletion and a unique
file. Parse-artifact lookup also requires a tenant-owned file matching the hash.

This is immediate protection for existing shared records, not complete storage
isolation. Shared files cannot yet be physically deleted independently. The
preflight is not atomic with concurrent ingestion; no claim is made that it
eliminates every ingest/delete race.

## Retained implementation and live gates

[Issue48](https://github.com/sass-maker/knowledge-base/issues/48) owns the remaining
work. The internally gated implementation below adds tenant/file-owned objects,
scoped parse identity, immutable raw/parse keys and durable generation checks.
Existing records still require an explicit copy/backfill plan and verification
before legacy shared objects can be removed. Production activation and legacy
migration remain separately authorized work.

Qualification must cover identical content across tenants/domains, legacy keys,
concurrent jobs, retries and partial failures, independent physical cleanup,
and then an authorized deployed synthetic consumer run. The signed-in operator
dashboard remains unverified. No migration, deployment, hosted upload, credential
access, new dependency or model/provider call was performed here.

Initial guard validation: `pnpm quality` passed, including 364 Worker tests in 35 files, six
dashboard tests, app typecheck/lint/build, landing checks/build, docs validation
and all configured code-health gates. Existing debt baselines remain unchanged.

## Internally enabled ownership protocol

Migrations `0008_file_artifact_ownership.sql` and
`0009_file_publication_visibility.sql` are additive source only. Production
continues through the default legacy path. Tests explicitly set
`AppOptions.ownedFileProtocol`; no environment/configuration switch was added.

The new path reserves immutable per-file raw keys before writing, records every
parse/document/vector intent, claims writers with conditional D1 transactions,
and publishes metadata with a transactional generation guard. File tombstones
survive physical file-row removal. Cleanup waits for all recorded writers to
settle; no operation expires or is stolen. An uncertain provider response remains
pending until recovery establishes settlement. This is an availability limit,
not a completed recovery mechanism.

Per-file structured facts and relationship evidence produce derived views from
surviving published generations. Removing the latest source restores the prior
source's fields and citations. Relationship backfill checks current publication;
it cannot resurrect tombstoned evidence. File, chunk, document and semantic
reads enforce visibility. Durable scope revisions invalidate query, answer and
lexical caches across independent handlers. Old cache entries become unreachable
and expire normally.

The protocol returns 202 while cleanup is pending and reports completion only
for indexed file artifacts. For Vectorize, an accepted upsert that is not yet
visible is not proof of absence: cleanup first establishes visibility, then
checks absence after deletion. Bindings without confirmation support stay
pending. Saved conversations, query traces and coordination/shared identity
metadata remain; this is not account-wide erasure. The response explains retained
history in plain language. Historical citations cannot fetch removed sources or
become evidence in new queries.

## Integration receipts

`tests/file-ownership.test.ts` contains 23 checks using actual migrations in
synthetic SQLite with foreign keys enabled. Actual Hono handlers use that D1
adapter; only external storage/vector/embedding bindings are simulated.

- Legacy reads, duplicate reservation, owner scope, transaction rollback,
  immutable IDs, token replay/collision and persistent tombstones.
- Multipart upload -> inline ingestion -> exact file/page/excerpt citation ->
  scoped parse lookup -> independent deletion of identical-content tenant files.
- Separate handlers with controlled raw PUT, parse PUT and vector-upsert barriers:
  delete returns 202, stale publication fails, cleanup completes after settlement.
- Delayed accepted vector mutations, uncertain provider writes with ancient
  timestamps, partial R2 cleanup failure and repeated source-set deletion.
- Direct text/records, queue processing, reprocess, infer-upload and mocked URL
  import. EDGAR uses the same imported-file persistence helper; no live source or
  provider access was attempted.
- Owned object registration copies verified bytes to a new key; foreign objects
  are denied. Ambiguous same-tenant hashes require a file ID.
- Surviving entity fields, graph/lineage/backfill and field provenance; pending
  deletion hides operator chunks and semantic metadata. Saved histories remain
  but cannot republish removed evidence.
- Generic index ingestion remains supported. Reserved owned metadata/resource IDs
  cannot be overwritten or deleted through generic routes; errors direct callers
  to the KB deletion path.

Run `pnpm exec vitest run tests/file-ownership.test.ts` from the Worker package,
then `pnpm quality` at the repository root. These local receipts do not qualify
Cloudflare provider convergence, deployed D1 behavior, PDF/OCR quality or the
signed-in operator dashboard.

Final integrated validation: `pnpm quality` passed with 387 Worker tests in 36
files, six dashboard tests, app and landing typechecks/builds, documentation
validation and every configured code-health gate. Existing baselines were not
raised. The 23 ownership tests execute the actual additive SQL and handlers;
provider bindings remain deterministic local fixtures.

## Remaining rollout and recovery gates

[Issue 48](https://github.com/sass-maker/knowledge-base/issues/48) remains open.
Do not enable the new protocol until the migration/rollout is reviewed. Legacy
records retain their original keys and global parse rows. Before rewriting them,
drain old writers, inventory references, copy raw bytes to owned keys, verify
hash/length, regenerate per-file parse provenance and indexed generations, and
verify compatibility before switching publication. Legacy shared objects require
a separate zero-reference garbage-collection review; per-file deletion must never
remove them. No automatic legacy copy, backfill or garbage collection runs here.

Recovery must reconcile abandoned operation intents and establish external-write
settlement before physical completion. An elapsed lease alone is insufficient.
Live binding convergence and an authorized synthetic consumer/operator journey
remain unverified. No production migration, backfill, activation, deployment,
hosted upload, provider/model call or new dependency was performed.

## Read-only legacy inventory

From `cloudflare/worker`, run `pnpm inventory:legacy-ownership --database /path/to/local-snapshot.sqlite --project PROJECT` against a complete administrative SQLite snapshot. The command opens the file read-only and reads a single transaction snapshot. It has no provider client or mutation mode. Treat the JSON output as private operational metadata.

The report preserves each tenant/file identity, counts shared raw keys and hashes across the supplied snapshot, proposes separate owned raw keys and identifies unresolved ingest jobs, running operations and inconsistent ledger metadata. It does not infer ownership from a `raw/v2/` prefix or settlement from operation age. Pre-ownership schemas are reported explicitly; missing files, unknown projects and partial ownership schemas fail.

This is inventory preparation only. Even an empty report cannot prove completeness, drained writers, verified raw bytes, rebuilt parse/indexed provenance or provider convergence. Existing managed records are not certified healthy by this report. Byte-copy verification, backfill publication and uncertain-write reconciliation remain open in issue 48. Shared legacy objects must remain until a separate zero-reference cleanup review.
