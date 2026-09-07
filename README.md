# SaaS Maker Knowledgebase

[![CI](https://github.com/sass-maker/knowledge-base/actions/workflows/ci.yml/badge.svg)](https://github.com/sass-maker/knowledge-base/actions/workflows/ci.yml)
[![worker-tests](https://img.shields.io/badge/worker_tests-passing-brightgreen)](#)

Private shared retrieval infrastructure for SaaS Maker projects, with schemas,
citations, and provenance for agents. This repository and its Cloudflare
deployment remain independent; it is not a public standalone product.

This repo owns the Cloudflare-native shared RAG Worker in
`cloudflare/worker`. That Worker is the SaaS Maker `RAG_SERVICE`: service-key
authenticated ingestion/query APIs backed by the fleet `free-ai` gateway
(embeddings + synthesis), Workers AI (fallback + rerank/OCR), Vectorize, D1, and
R2.

Each child project receives an isolated scope for its private information and
uses the cited search API (`/search`) or grounded answer API (`/query`). The
internal dashboard discovers real project scopes and hides demonstration,
smoke, proof, and performance data by default.

The wedge is intentionally narrower than "generic RAG":

- Exa searches the open web; this searches your private/specialized corpus.
- Agents get ranked cited evidence directly, not only a chat response.
- Schemas make extraction and filtering explicit when the corpus has domain shape.
- Schema inference can start from representative uploaded files before ingestion.
- Every useful response points back to file, page, and excerpt.

## Qualification and remaining work (2026-09-07)

This remains private shared infrastructure. The public repository and explanatory
landing page can be reviewed; they do not provide an anonymous document-search
product.

The default service still uses the conservative shared-object deletion guard:
409 prevents known shared raw/parse objects from being removed. This guard is
not atomic with concurrent legacy ingestion.

An internally enabled ownership protocol now has actual Hono-handler proof
against migrated synthetic SQLite: immutable per-file uploads, scoped parse
artifacts, cited text/record retrieval, surviving entity/graph evidence, queue
and reprocess, concurrent deletion, and retryable physical cleanup. Separate
handler caches stop returning deleted evidence. R2, Vectorize and embeddings
remain deterministic fixtures; no live provider quality is established.
[Reproduction and limits](docs/development/document-workflow-qualification-2026-09-07.md).

**The new protocol is not activated.** It requires additive migrations 0008/0009,
reviewed rollout, verified legacy copy/backfill, recovery for unsettled operations,
and authorized deployed consumer/operator qualification. Existing legacy files
are preserved; no production upload, migration, deployment or credential access
was performed.

Deletion distinguishes immediate removal from search from physical cleanup of
indexed file artifacts. A pending write or unconfirmed vector mutation returns
202. Saved conversations and query traces remain; their old source links cannot
retrieve deleted files or republish them into new results.

Task reconciliation: **one open issue, zero open PRs, zero closures**.
[Issue 48](https://github.com/sass-maker/knowledge-base/issues/48) retains activation,
legacy migration/recovery and live qualification. Local proof is not deployment
or completion of the legacy migration.

## What's interesting about this one

**Verified across 5 LLMs × 2 unrelated domains** (SEC EDGAR filings + SPDX legal licenses), with one counter-intuitive empirical result:

> On this RAG pipeline, **`groq-llama-3.1-8b` beats `gemini-2.5-pro` by 24 pass-rate points** on SEC. Bigger models hedge, smaller decisive ones don't — when retrieval is solid, the synthesis model becomes a rephrase-and-commit job that cheap models do *better*.

This inversion is **contingent on retrieval quality**: the cheap-decisive synth is a retrieval-quality multiplier (see `docs/knowledge/archive/notes-python-era.md` §4.7). With reranker+RRF off, the 8b model would happily commit to wrong sources and the result flips. The right framing isn't "8b wins" — it's "no fixed model wins; the right synth depends on whether your context is solid enough that decisiveness pays off."

Three historical moments documented honestly in `docs/knowledge/archive/learning-python-era.md`:
1. The DuckDB structured-query route was silently broken for 5 eval rounds (missing dep + import outside try) — every aggregate question 500'd, eval logged as `query_error`, all v0-v5 numbers achieved despite this. Caught by loud-error-logging, fixed.
2. A methodology bug in the retired Python reference stack — process-level env overrides did not propagate to the running API server, so 3 supposedly-different cross-model eval runs were the same model under different labels. Caught when two report files had identical MD5.
3. A citation-hygiene gap I introduced in my own GraphRAG sketch (entity-graph themes shaped the answer but their `entity_mentions` weren't in the citation list) — caught it in self-review, closed it before shipping.

The project mantra **"cited or it didn't happen"** holds through every retrieval path: hybrid + structured DuckDB + GraphRAG-sketch + Self-RAG retry + vision-LLM tables, all wired to terminate at a retrievable `(file_id, page, excerpt)` triple.

## Reading guide

The canonical knowledge system lives under [`docs/`](docs/index.md) with
[`STATUS.md`](STATUS.md) as the short live-status view and
[`AGENTS.md`](AGENTS.md) as the agent bootloader. Sorted by how much time you
have:

**5 min — the product + architecture**
- [`docs/product/overview.md`](docs/product/overview.md) — thesis, wedge, surfaces, empirical headline.
- [`docs/architecture/overview.md`](docs/architecture/overview.md) — runtime, ingestion, retrieval, testing surface.
- [`docs/architecture/decisions.md`](docs/architecture/decisions.md) — the non-obvious architectural choices and the why behind each.

**15 min — decision depth + the empirical headline**
1. [`docs/architecture/decisions.md`](docs/architecture/decisions.md) — durable decisions (A1–A12).
2. [`docs/knowledge/learnings.md`](docs/knowledge/learnings.md) — the five distilled lessons.
3. [`docs/knowledge/archive/notes-python-era.md`](docs/knowledge/archive/notes-python-era.md) §4.7 — the cross-domain × cross-model matrix behind the headline finding.

**Operator-flavored**
- [`docs/operations/runbook.md`](docs/operations/runbook.md) — operator runbook
- [`docs/operations/dashboard-access.md`](docs/operations/dashboard-access.md) — internal dashboard identity and proxy setup
- [`docs/product/demo-walkthrough.md`](docs/product/demo-walkthrough.md) — guided demo
- [`docs/product/onboard-new-domain.md`](docs/product/onboard-new-domain.md) — adding a third domain in ~30 min
- [`docs/product/agent-search-direction.md`](docs/product/agent-search-direction.md) — product direction + gap map
- [`docs/product/bring-your-own-corpus.md`](docs/product/bring-your-own-corpus.md) — self-serve private corpus flow
- [`docs/product/agent-tool-contract.md`](docs/product/agent-tool-contract.md) — how agents should call `/search` and `/query`
- [`docs/product/agent-integration-examples.md`](docs/product/agent-integration-examples.md) — tool contract + wrapper examples
- [`docs/operations/hosting-personal.md`](docs/operations/hosting-personal.md) — personal hosting checklist and smoke tests

**Historical archive (Python era, preserved snapshots)**
- [`docs/knowledge/archive/writeup.md`](docs/knowledge/archive/writeup.md) — original 4-page submission brief.
- [`docs/knowledge/archive/notes-python-era.md`](docs/knowledge/archive/notes-python-era.md) — long-form engineering notes (~25 pages).
- [`docs/knowledge/archive/learning-python-era.md`](docs/knowledge/archive/learning-python-era.md) — full session story + decision log.
- [`docs/knowledge/archive/live-verification.md`](docs/knowledge/archive/live-verification.md) — recorded live-run output of the eval pipeline.
- [`docs/knowledge/archive/grok-findings.md`](docs/knowledge/archive/grok-findings.md) — external code review (13 findings, all resolved).
- [`docs/knowledge/archive/session-log.md`](docs/knowledge/archive/session-log.md) — post-submission session log.
- [`docs/knowledge/archive/project-status-2026-06-28.md`](docs/knowledge/archive/project-status-2026-06-28.md) — detailed status snapshot.
- [`docs/knowledge/archive/cloudflare-agent-handoff.md`](docs/knowledge/archive/cloudflare-agent-handoff.md) — migration handoff snapshot.
- [`docs/knowledge/archive/highsignal-integration-cancelled-2026-07-25.md`](docs/knowledge/archive/highsignal-integration-cancelled-2026-07-25.md) — cancelled High Signal integration proposal.

**Maintaining the docs themselves**
- [`docs/maintenance.md`](docs/maintenance.md) — how to edit this knowledge system and validate links.

## Architecture

```mermaid
flowchart LR
    User[User or agent] -->|HTTP /v1/kb/search or /v1/kb/query| Worker[Cloudflare Worker]
    Worker --> Pipeline

    subgraph Pipeline[Cloudflare-native query pipeline]
        direction TB
        S1[D1 structured route + filters] --> S2[D1 graph expansion]
        S2 --> S3[rewrite + decompose fanout]
        S3 --> S4[Vectorize + D1 fuzzy lexical RRF]
        S4 --> S5[MMR + local rerank]
        S5 --> S6[optional Workers AI rerank]
        S6 --> S7[MMR diversity]
        S7 --> S8[corrective lexical retry]
        S8 --> SearchOut[ranked cited evidence]
        S8 --> S9[extractive or Workers AI cited answer]
        S9 --> S10[answer support checks]
        S10 --> S11[span_cite]
    end

    Files[upload / URL / EDGAR / direct text / JSON] -->|POST /v1/kb/*| Worker
    Worker -.-> Queue[Queues + Workflows]

    Pipeline --> D1[(D1<br/>entities, jobs,<br/>traces, evals)]
    Pipeline --> Vectorize[(Vectorize<br/>dense indexes)]
    Worker --> R2[(R2<br/>raw + parse artifacts)]
    Worker --> FreeAI[(free-ai gateway<br/>embeddings + synthesis)]
    Worker --> AI[(Workers AI<br/>fallback + rerank/OCR)]

    classDef store fill:#e8f4f8,stroke:#0288d1,color:#01579b
    class D1,Vectorize,R2,FreeAI,AI store
```

The SEC and Legal domains remain checked-in evaluation fixtures that prove the
same pipeline works across unrelated schemas. They are not SaaS Maker product
data and are hidden from the default operator view. See
[`docs/product/onboard-new-domain.md`](docs/product/onboard-new-domain.md) for
the reusable onboarding workflow.

## Worker Commands

```bash
make worker-check        # typecheck + Worker tests
make worker-preflight    # local wrangler binding check
make worker-gaps         # full-port blocker inventory
make worker-ocr-dry-run  # local scanned-PDF OCR eval payload proof, no network/AI
make worker-local-cutover-smoke # boot wrangler dev and prove aliases + fingerprint locally
make worker-predeploy-local # check + preflight + OCR dry-run + local smoke + deploy dry-run
cd cloudflare/worker && pnpm run audit:legacy-route-parity
cd cloudflare/worker && pnpm run audit:python-runtime-retirement -- --require-complete
cd cloudflare/worker && pnpm run audit:sibling-rag-service -- --json --require-retired
cd cloudflare/worker && pnpm run deploy:dry-run
cd cloudflare/worker && pnpm run smoke:legacy-routes -- --base-url "$RAG_BASE_URL" --require-complete
cd cloudflare/worker && RAG_SERVICE_KEY=<service-key> pnpm run release-status:embedding-model -- --json --check-vectorize-metadata-indexes --check-knowledgebase-embedding-models
cd cloudflare/worker && RAG_SERVICE_KEY=<service-key> pnpm run readiness:embedding-model
cd cloudflare/worker && RAG_SERVICE_KEY=<service-key> RAG_BASE_URL="$RAG_BASE_URL" pnpm run smoke:rag-crud:embedding-model
cd cloudflare/worker && RAG_ALLOW_LIVE_OCR=1 RAG_SERVICE_KEY=<service-key> pnpm run readiness:full-port
cd cloudflare/worker && KARTE_SESSION_COOKIE=<cookie> STARBOARD_SESSION_COOKIE=<cookie> pnpm run smoke:consumer-auth -- --require-authenticated
cd cloudflare/worker && RAG_SERVICE_KEY=<service-key> pnpm run proof:s -- --domain <domain> --output-dir /tmp/kb-s-proof
```

After deploying this port, the `/healthz` row in `smoke:legacy-routes` should
show `deploy_fingerprint=knowledgebase-cloudflare-embedding-models-2026-06-21`;
`smoke:legacy-routes --require-complete` and `readiness:full-port` fail if the
deployed Worker reports a different fingerprint.
`readiness:full-port` cost-guards the live OCR eval: it skips Workers AI OCR
until the deployed root aliases and fingerprint prove the current Worker build,
and still requires `RAG_ALLOW_LIVE_OCR=1` or `--allow-live-ocr` before spending
Workers AI OCR. It also verifies the deployed `/` and `/ui` hosted testing
surface includes the embedding-model selector and custom-input `/v1/kb/*`
controls.
Before deploying, `pnpm run smoke:local-cutover` starts `wrangler dev --local`
on an ephemeral port and runs the same legacy alias + fingerprint smoke against
the local Worker bundle.
`pnpm run predeploy:local` wraps the local deploy-readiness sequence: Worker
tests/typecheck, binding preflight, Python runtime retirement audit, no external
fleet references to the old `rag-service`, Linkchat/Starboard consumer
knowledgebase RAG integration audit, local Linkchat/Starboard Cloudflare bundle
builds, the local `../free-ai` embedding catalog contract audit, the upstream
free-ai cost/type/test check, the Vectorize embedding binding selectability audit, the
full-port gap matrix, the no-network NVDA scanned-PDF OCR eval payload dry-run,
the read-only embedding-model release plan, local cutover smoke, and Wrangler
deploy dry-run.
`pnpm run scorecard:s` is stricter than A+: it requires authenticated Karte and
Starboard consumer-smoke evidence, real consumer eval packs, non-cache latency
buckets, trace drilldown/export evidence, and explicit ingestion
idempotency/replay/preview/failure-classification evidence. Without the product
session cookies, `pnpm run smoke:consumer-auth` reports skipped authenticated
flows and S proof correctly remains blocked.
The ingest APIs expose that proof directly: `/v1/kb/ingest/record`,
`/v1/kb/ingest/text`, `/v1/kb/ingest/jobs/:job_id`, and
`/v1/kb/ingest/runs/:run_id` include idempotent replay status, chunk previews,
reprocess routes, and classified failures where applicable.
`proof:s` seeds the eval fixture documents through `/v1/kb/ingest/text` before
running query evals and benchmarks, so the live S proof is reproducible from the
checked-in fixture instead of relying on pre-existing tenant data.
The S fixture can also declare an embedding model/provider; the current proof
uses the selectable Workers AI small embedding profile for the speed/accuracy
S gate while keeping domain-level embedding choice explicit.
The sibling `../rag-service` repo is already retired. Use
`pnpm run audit:sibling-rag-service -- --json --require-retired` to prove it
stays gone. The current embedding-model release is live: matching `../free-ai`
embedding catalog deployed, all advertised Vectorize dimensions provisioned with
metadata indexes, D1 migrations `0005_index_embedding_model.sql` and
`0006_kb_domain_embedding_model.sql` applied, this Worker deployed, and the
read-only selected-model readiness plus mutating
`smoke:rag-crud:embedding-model` gates green.

Open the Cloudflare Worker testing UI at `/ui` on the deployed Worker.

## Try it from the command line

The six most interesting endpoints, copy-paste-ready:

```bash
export RAG_BASE_URL="${RAG_BASE_URL:-https://knowledgebase.sarthakagrawal927.workers.dev}"
export RAG_SERVICE_KEY="<service-key>"

curl -s "$RAG_BASE_URL/v1/healthz" | jq

curl -s -X POST "$RAG_BASE_URL/v1/kb/query" \
  -H "Authorization: Bearer $RAG_SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"domain":"sec","question":"What does NVIDIA disclose about U.S. export controls?","top_k":5}' \
  | jq '{answer, citations, confidence}'
```

| Endpoint | What it does |
| --- | --- |
| `GET /v1/healthz` | Public Worker health check for D1 and Vectorize binding reachability |
| `GET /readyz` | Public compatibility readiness probe for D1, Vectorize, and R2 |
| `GET /metrics` | Public Prometheus-compatible compatibility scrape endpoint |
| `GET /ui` | Worker-hosted testing UI |
| `POST /v1/kb/query` | Cited answer path over D1, Vectorize, R2 artifacts, and optional Workers AI |
| `POST /v1/kb/query/stream` | SSE query lifecycle stream with `started`, `stage`, and final `answer`/`error` events |
| `POST /v1/kb/files/upload` | Upload a file into R2/D1 and queue ingest |
| `POST /v1/kb/ingest/record` | Direct structured JSON ingestion with schema inference for new domains |
| `POST /v1/kb/ingest/text` | Direct text ingestion |
| `POST /v1/kb/evals/parse` | Parser-quality eval reports for migrated/fixture cases |
| `GET /v1/kb/projects` | Project inventory |
| `GET /v1/kb/sessions` | Query/session history |

Retired FastAPI paths are preserved as authenticated compatibility aliases on
the Worker: `/search`, `/agent/search`, `/search/eval`, `/query`,
`/query/stream`, `/query/traces`, `/query/trace/:id`, plus the old product
prefixes `/projects`, `/domains`, `/schemas`, `/files`, `/sources`,
`/entities`, and `/ingest/*`.

## How this was built — AI-assistance disclosure

Built with heavy assist from Claude Opus 4.7 (visible as the co-author on commits). Being explicit about the split:

| What I owned | What was collaborated |
| --- | --- |
| Architecture decisions for the historical Python reference and current Cloudflare Worker migration | Implementation mechanics for each stage |
| Scope boundaries (which features to ship, which to cancel — e.g., the explicit cancel + reasoning on task #82 retrieval iteration) | Library swap mechanics (instructor, structlog, parser/runtime migration) |
| When to debug vs when to defer (the cross-model methodology bug → re-run with proper env propagation; the DuckDB ticker→canonical→noise-floor chain) | Code-level refactors |
| Citation hygiene as a non-negotiable across new routes (caught my own GraphRAG-citation gap in self-review) | Test scaffolding, doc rewrites |
| The empirical methodology (5×2 matrix, judge held constant, deterministic LLM cache for reproducibility) | Doc generation from my notes |

The decision log in `docs/knowledge/archive/learning-python-era.md` was written from my own session notes; the durable choices are distilled in `docs/architecture/decisions.md`.

## Current Worker Source Tree

| Path | What |
| --- | --- |
| `cloudflare/worker/src/` | Hono Worker API, testing UI, D1 repository, parsers, retrieval/query pipeline |
| `cloudflare/worker/scripts/` | Migration, smoke, benchmark, eval, preflight, and full-port gate tooling |
| `cloudflare/worker/migrations/` | D1 schema for RAG and knowledgebase product state |
| `cloudflare/worker/tests/` | Worker unit/integration coverage |
| `cloudflare/full-port-gaps.json` | Executable full-port blocker inventory |
| `domains/sec/` | Demo schema + config + 25-question eval set for SEC EDGAR filings |
| `domains/legal/` | Demo schema + config + 12-question eval set for SPDX licenses |
| `data/minio/` | Local legacy raw/parse fixture mirror used by Worker migration/eval scripts |

## Historical Python Performance

These numbers describe the retired Python reference path, not the Cloudflare
Worker runtime. Worker performance evidence lives in `cloudflare/worker`
benchmarks and project status.

| Stage          | Typical p50 (ms) | Notes |
| -------------- | ---------------: | ----- |
| `intent`       |              ~3 000 | Cached when KB_LLM_CACHE_DIR is set; warm calls < 5 ms |
| `duckdb`       |                 ~600 | LLM-generated SQL over in-memory DuckDB views |
| `graph_route`  |             ~18 000 | Fires only on theme-shape questions |
| `rewrite`      |             ~10 000 | Multi-query expansion + HyDE; parallel-friendly |
| `retrieve`     |                 ~300 | Qdrant hybrid (dense + sparse + RRF) |
| `rerank`       |             ~9 000 | Cross-encoder (jina-v2 base) on CPU; first call ~25 s incl. model load |
| `mmr`          |                  ~5 | Pure-Python diversity reranker over the rerank pool |
| `crag`         |                  ~4 | Cache hit; cold ~14 s |
| `self_rag`     |                   0 | Triggered only when `crag_score < 0.4`; bounded to 1 retry per request |
| `synthesize`   |             ~12 000 | The single biggest spend; varies wildly with model + context size |
| `verify`       |             ~16 000 | AIS entailment per claim |
| `span_cite`    |                 ~400 | Per-citation best-span via dense cosine over chunk text |

End-to-end p50 was about **30 s warm**, **80 s cold** in the retired Python
path. Current Worker benchmark scripts live under `cloudflare/worker/scripts`.

For sub-second response on Cloudflare, use the Worker defaults: extractive
answers, D1 lexical/entity fast paths, cached popular queries, and optional
Workers AI synthesis only when the caller needs generated prose.

## Worker Domain Onboarding

The active product path is configured through D1 state and Worker bindings, not
the historical Python YAML pipeline. Keep the checked-in `domains/<name>/`
fixtures for evals and migration reference, then use the Worker API for live
corpora:

```bash
cd cloudflare/worker
pnpm run preflight

# Apply or infer a schema through /v1/kb/schemas/* for file inputs, then ingest:
# POST /v1/kb/files/upload
# POST /v1/kb/ingest/run
# POST /v1/kb/ingest/record # infers a schema for a new structured domain
# POST /v1/kb/ingest/text  # indexes inline by default and does not require a schema
```

No code change is required to onboard a new domain; create or infer the schema
through the Worker, post direct records, ingest files, and query through
`/v1/kb/search` or `/v1/kb/query`.

For agent frameworks, use the checked-in
[OpenAI Agents SDK and LangChain.js examples](docs/product/agent-integration-examples.md).
Both preserve the complete citation payload returned by the typed client
contract.
