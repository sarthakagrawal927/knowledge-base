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

### Verified offline raw staging

From `cloudflare/worker`, `pnpm stage:legacy-raw --database /path/to/snapshot.sqlite --project PROJECT --object-root /path/to/object-export --output-root /path/to/staging` verifies the exported raw bytes against each file's recorded SHA-256 and size. The output directory must have an existing parent and be separate from the object export. The source export maps R2 keys to relative paths; absolute paths, dot segments and paths escaping the export are rejected.

Each proposed owned key maps to a separate SHA-256-named `.bin` file, avoiding filesystem aliasing from identity characters. Outputs are created exclusively and reread; existing identical output is reusable, while conflicting output is retained and rejected. `manifest.json` records source/owned keys, verified hashes and sizes without document contents. Keep it private. Source bytes and the SQLite snapshot stay unchanged. Missing ownership migrations permit offline staging only; unresolved writers or inconsistent ownership still block it.

Staging exported bytes does not establish current R2 contents, drained production writers, parse/indexed provenance or completed migration. The command does not upload, change metadata, publish, activate the owned protocol or delete shared legacy objects. Those requirements remain in issue 48.


### Offline parse provenance reconstruction (2026-09-09 source candidate)

Run from `cloudflare/worker` with Node 24 and the package's frozen development
installation:

```sh
pnpm stage:legacy-parse --database /path/to/snapshot.sqlite --project PROJECT --raw-stage-root /path/to/raw-staging --output-root /path/to/parse-staging
```

This consumes a **version 2** raw staging manifest (including filename and MIME),
rechecks its complete file set and owner/domain/file/hash/size identity against
the read-only snapshot, then rereads and verifies every immutable raw file.
Older version 1 manifests must be regenerated by `stage:legacy-raw` into a new
empty directory; existing manifests are never overwritten. No globally shared
legacy parse object is copied or relabelled.

Text, CSV/JSON, DOCX, XLSX and PPTX reuse the existing local parser. PDF text
reconstruction uses pinned Apache-2.0 `pdfjs-dist` 6.3.289 as an offline-only
**development dependency**, following Mozilla's
[Node page extraction API](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs).
Its page tree establishes page numbers independently of object order. Each PDF
document retains page, excerpt and owner/file metadata. The Worker keeps its
existing parser and aggregate behavior; no Worker source imports PDF.js.

Unsupported formats, invalid binary text, encrypted/malformed PDFs and any PDF
page with no extractable text are blocked explicitly. A textless page may be
blank or require OCR; neither is silently omitted or sent to a provider. Limits
are 64 MiB per raw artifact and 256 MiB per batch (checked before raw reads), 500 PDF pages and 8 MiB of extracted PDF text.
Existing local structured-record limits also block truncated reconstruction.
This does not certify semantic completeness or correctness of arbitrary formats.

Output JSON uses the same parse-artifact assembly as ingestion, with deterministic
owner/file candidate keys and content hashes. Identical retries reuse verified
files; conflicts remain untouched and fail. A failed multi-file attempt may leave
verified partial outputs for retry; the directory is not an atomic transaction.
Keep staged document contents and manifests private.

**Every manifest remains `readyForPublication: false`.** Candidate generation and
operation IDs are planning identities, not D1 ledger reservations. No R2 upload,
D1 migration/write, provider call, indexed/structured publication, activation,
legacy removal or uncertain-operation settlement occurs. Before any future
publication, revalidate the live writer drain and snapshot, reserve actual ledger
identities, rebuild indexed/structured provenance, and verify physical convergence.
Those requirements and account-backed acceptance remain open in
[issue 48](https://github.com/sass-maker/knowledge-base/issues/48).


Local candidate validation: 411 Worker tests (38 files), 6 dashboard tests,
Worker/dashboard typechecks, dashboard build, and landing check/build/agent
surfaces passed. The 16 new staging tests include actual CLI reopening,
TXT/CSV/JSON/DOCX/XLSX/PPTX, same-byte files across domains and tenants,
identity/hash rejection, immutable conflict/idempotence, valid PDF xref with
reversed physical page order, encrypted/image/textless PDFs, and raw/batch/page limits.
The PDF test disables network fetch. Worker dry-run output was 1797.89 KiB
(313.43 KiB gzip); its 501-source map contains no PDF.js or offline PDF module.
Format, docs, unused, complexity, duplication, cycles, suppressions and diff
hygiene passed. The core-only dependency gate identified pre-existing advisories; a separately
reviewed dependency repair follows. No production action occurred.


### Dependency gate follow-up (2026-09-09)

The separate maintenance change updates existing root Sharp and scoped
Wrangler/Miniflare Sharp to 0.35.4, ESLint's js-yaml to 4.3.2, and the static
landing's Astro 7.1.6 to 7.2.8 with Sharp 0.35.4, js-yaml 4.3.2 and SVGO 4.1.0.
No provider configuration, runtime product dependency or landing source changed.
Resolved exceptions were removed and high-advisory ceilings lowered; remaining
accepted debt is root 0, dashboard 8, Worker 4 and landing 1 (zero critical).

Full `pnpm quality` passes on Node 24.20.0: 411 Worker tests, 6 dashboard tests,
dashboard/landing builds and all maintenance gates. Twelve real Sharp
encode/decode checks cover PNG, lossless WebP and JPEG across all four resolved
package paths, including exact lossless pixel equality. At 390px and 1440px,
landing visible text, 55 links and viewport fit match the pre-update build (local
server ports normalized inside AI prompt links). Screenshot differences are
confined to the existing animated footer strip; no spacing configuration change
was needed. The [machine-readable local receipt](dependency-repair-2026-09-09.json)
records these checks. This does not qualify hosted owner ingestion, migration,
backfill or activation; issue 48 remains open.
