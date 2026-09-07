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
work. A next bounded source design can add tenant/file-owned object records and
scoped parse-artifact identity, plus new scoped raw/parse keys. It must retain
read compatibility for old records and produce an explicit, separately authorized
copy/backfill plan before any legacy object deletion. Ingest/reprocess/delete
also need durable tombstone or generation checks so in-flight jobs cannot revive
or erase deleted files. Per-process locks are insufficient.

Qualification must cover identical content across tenants/domains, legacy keys,
concurrent jobs, retries and partial failures, independent physical cleanup,
and then an authorized deployed synthetic consumer run. The signed-in operator
dashboard remains unverified. No migration, deployment, hosted upload, credential
access, new dependency or model/provider call was performed here.

Validation: `pnpm quality` passed, including 364 Worker tests in 35 files, six
dashboard tests, app typecheck/lint/build, landing checks/build, docs validation
and all configured code-health gates. Existing debt baselines remain unchanged.

## Inactive ownership foundation

Migration source `0008_file_artifact_ownership.sql` and `src/file-ownership.ts`
add a separately tested ownership ledger. Product routes do not call it yet;
all existing intake modes remain unchanged. This is a checkpoint toward
[issue 48](https://github.com/sass-maker/knowledge-base/issues/48), not activation
of independent shared-file deletion.

Eight tests in `tests/file-ownership.test.ts` apply the actual migrations to
synthetic SQLite with foreign keys enabled. They exercise legacy compatibility,
immutable duplicate registration, atomic writer claims, token collision rollback,
tenant isolation, persistent tombstones, pending vector cleanup and a delayed
object write spanning deletion. Two repository instances share the database.
These are repository/state-machine tests, not concurrent Hono handler proof.
No unsettled operation expires or is stolen; abandoned operations remain pending.

The next integration must cover every supported intake/reprocess mode, scoped
parse publication, complete document/structured evidence cleanup, durable query
and cache visibility, provider convergence and legacy copy verification before
routes can activate the protocol. No production migration or backfill ran.
