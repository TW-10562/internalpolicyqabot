REPORT.md
1) Executive Summary
Your current RAG pipeline is working but inefficient and brittle for broad all-file search. The biggest issue is not that retrieval fails entirely, but that it often retrieves a mixed context set, then spends latency on query-translation retries and broad lexical candidate loops before LLM generation.

For your “access card + parking slot” example, logs show relevant docs are present, but retrieval/candidate selection still includes weakly related docs and context assembly often pulls non-focused snippets. That increases latency, token waste, and answer instability.

Recommendation: GO (staged rollout) on adding Staged Hybrid Filtering:

Stage 1: metadata pre-filter (department/access/doc scope/date/language/doc_type/source)
Stage 2: ANN/hybrid retrieval only on filtered subset
Stage 3: lightweight post-filter/fallback widening
This is a medium-risk, high-upside change if implemented with guardrails and feature flags.
Do not hard-switch; ship as A/B with fallback to current behavior.

2) Current System Findings (with file/function references)
A. Retriever entrypoints and runtime path
Task creation always forces RAG path for chat and sets allFileSearch: true, usedFileIds: [] in getAddMid.
Chat jobs are consumed by worker queue in worker.ts (line 25), executing chatGenProcess.
Retrieval orchestration happens in callAviary, including file-scope resolution, Solr search, rerank/gating, backend semantic fallback, and context assembly.
B. Query parsing and filters (current behavior)
Language routing and optional working-query translation are done in buildWorkingQuery and retrieval translation cache helper translateQueryForRetrieval.
Candidate query generation is in buildRetrievalCandidates.
Solr search loop is runSolrSearch with CJK/EN wildcard fallbacks.
Existing metadata filters in retrieval:
specific file-id filter via Solr fq={!terms f=id} from storage_key (chatGenProcess.ts (line 932))
department filter via department_code_s (chatGenProcess.ts (line 938))
There is no staged metadata prefilter layer before retrieval candidate generation.
C. Embedding model and embedding generation
Embeddings are generated in embedder.py (line 76), using HuggingFaceEmbeddings by default and exposing embed_text / embed_text_batch.
Default embedding model configured as BAAI/bge-m3 in default.yml (line 61).
Split-by-article ingestion embeds article text in splitByArticle_api.py (line 619).
D. Vector DB / ANN index type and query
Vector store is Chroma via PersistentClient in chroma_repository.py (line 8).
Hybrid retrieval endpoint is /search/hybrid, request schema in HybridSearchRequest.
Search engine is HybridRAGSearchEngine.hybrid_search_rag, using:
vector-only: vectorstore.as_retriever(search_kwargs={"k": ...})
BM25-only and Ensemble hybrid.
Assumption: ANN backend is Chroma default (likely HNSW-like). No explicit index type config in repo.
E. Reranker usage
Backend reranker hook exists in _maybe_rerank, calling get_ranked_results.
Reranker is currently off by config usingRerank: false in default.yml (line 153).
API worker does local lexical rerank/term-hit scoring in chatGenProcess.ts (line 1137).
F. Chunking, top_k, context assembly
Chunking utility is in split_text and split-by-page config defaults chunkSize: 512, overlap: 128 (default.yml (line 125)).
Hybrid retrieval top_k defaults to 10 (default.yml (line 172), schemas.py (line 24)).
Worker context assembly uses bounded snippets in extractRelevantSnippet with DOC_CONTEXT_CHARS default 1200 (chatGenProcess.ts (line 85)), then constructs prompt at chatGenProcess.ts (line 1294).
G. Caching
Query translation cache exists in-memory (Map) in chatGenProcess.ts (line 97).
Backend engine/document caching exists in HybridRAGEngineFactory and BM25 document cache _ensure_all_documents.
I do not see active retrieval-result cache in current chatGenProcess path.
H. Observability
Stage-level perf tracing infra: ragPerf.ts (line 73), endpoints in ragMetrics.ts (line 8).
Query KPI persistence: recordQueryEvent, and KPI retrieval API at getQueryEventMetricsByTaskOutput.
Worker logs KPI inline at chatGenProcess.ts (line 1559).
Current Pipeline Diagram
flowchart TD
  A[POST /api/gen-task] --> B[getAddMid: force COMPANY + allFileSearch=true]
  B --> C[Bull queue: chat]
  C --> D[chatGenProcess.callAviary]
  D --> E[Resolve file scope from DB File table]
  D --> F[Language routing + optional query translation]
  F --> G[Solr lexical search over candidates + wildcard fallback]
  G --> H[Local rerank + relevance gates]
  H -->|no docs| I[/search/hybrid on RAG backend]
  H -->|docs| J[Context assembly: extractRelevantSnippet]
  I --> J
  J --> K[LLM generate]
  K --> L[Optional final translation]
  L --> M[Append SOURCE footer + save output + KPI]
3) Proposed Staged Hybrid Filtering Design (minimal disruption)
Stage 1: Metadata pre-filter (before ANN/lexical)
Use metadata that is already available now:

Filter	Available now	Source
department_code	Yes	file.model.ts (line 37), Solr department_code_s used in retrieval
requested_file_ids	Yes (if provided)	chatGenProcess.ts (line 756)
uploaded_by	Partially	splitByArticle extra metadata (uploaded_by_s)
rag_tag/source pipeline	Yes	Solr metadata fields in solrService.ts (line 63)
filename/title patterns	Yes	Solr title, file_name_s
created_at/date	DB yes	file.created_at
doc_type, language, access_level, author_verified	Not standardized	needs schema addition
Stage 2: ANN/hybrid on filtered subset
Extend /search/hybrid request with optional metadata_filters and candidate_file_ids.
Apply Chroma metadata filter in retriever search kwargs (currently only k is passed).
Keep current Solr path as fallback or blend source, but run ANN on narrowed pool first for semantically rich queries.
Stage 3: Lightweight post-filter
Drop low-signal results (score floor + term overlap + metadata consistency).
Enforce final result diversity + max-per-source.
If empty, progressively relax filters (not immediate global search).
Data model changes needed
Area	Exists	Add/Change
SQL file	department_code, created_at, create_by, tag	add normalized doc_type, language, access_level, effective_date, author_verified
Solr docs	id,title,file_name_s,file_path_s,content_txt,rag_tag_s (+ sometimes dept)	guarantee indexed+filterable fields: department_code_s, file_id_l, doc_type_s, language_s, access_level_s, effective_date_dt, author_verified_b
Chroma metadata	article metadata + file_id, uploaded_by_s, rag_tag_s, file_path_s (splitByArticle path)	guarantee same filter keys for all chunks and all ingestion paths
Indexing requirements
SQL indexes:
(department_code, created_at DESC)
(department_code, doc_type, language)
(access_level, department_code)
Solr: ensure filter fields are docValues-enabled and typed (*_s, *_dt, *_b, numeric id).
Chroma: ensure each chunk carries filterable metadata keys consistently.
Migration plan for existing vectors/docs
Backfill metadata in SQL (file/document_metadata) from current records and folder conventions.
Reindex Solr with guaranteed department/doc_type/language/access fields (reuse reindex script path).
Rebuild or metadata-update Chroma collection so all chunks have filter keys.
Enable staged filtering behind feature flag and run A/B.
Failure modes and guardrails
Too strict filters => empty results
Guardrail: progressive relaxation order (date -> doc_type -> source -> only department).
Stale metadata
Guardrail: versioned metadata schema + nightly integrity check.
Access leakage
Guardrail: mandatory RBAC filters always-on in Stage 1 and Stage 3.
Large filter lists hurting vector query
Guardrail: cap candidate ID list; fallback to coarser metadata filter.
Ingestion inconsistency (some docs only Solr)
Guardrail: health check showing per-doc Solr/Chroma parity before enabling hard ANN-first.
4) Expected Efficiency Gains (with assumptions)
Metrics definition
Retrieval latency: p50/p95 ms for Stage 1 + Stage 2 + Stage 3.
Total RAG latency: end-to-end task latency from worker.
Quality: precision@k, recall@k (or weak-proxy if no labels).
Context waste: % irrelevant or unused retrieval tokens.
Cost/query: token + retrieval compute (local GPU/CPU).
Measured baseline from your logs (sample, n=5 successful runs)
From the logs you shared (output IDs 20/24/25/26/27):

Total latency: avg 9649 ms, p50 8448 ms, p95 17745 ms
Retrieval (ragTime): avg 3236 ms, p50 2822 ms, p95 4892 ms
LLM (llmTime): avg 5463 ms, p50 3545 ms, p95 10252 ms
Query translation: avg 3044 ms, p95 4584 ms
Input/output token proxy (same samples): avg input ~1128 vs output ~30 (high context overhead)
Assumptions (explicit)
Corpus currently broad all-file mode (Found 64 file(s)) from your worker logs.
Average candidate docs currently 3-4 in context for this query family.
Chroma ANN behavior is approximate and benefits from metadata subset filtering.
No labeled relevance set exists yet; precision/recall estimated by proxy evaluation.
Scenario table (current vs staged hybrid filtering)
Scenario	Candidate reduction example	Retrieval latency impact	Total latency impact	Quality impact (expected)
Conservative	64 files -> 32 files	-15% to -25%	-8% to -15%	Precision@k up slight, recall flat/slight down if filters too strict
Expected	64 -> 8 files	-35% to -55%	-18% to -35%	Precision@k up medium, recall@k flat/up with fallback widening
Best case	64 -> 3 files	-55% to -75%	-30% to -45%	Precision@k up high, context waste sharply down
Why this should help your specific issue
Your current candidate selection can prefer high lexical score on broad English tokens even when translated candidate has better policy intent match. Staged metadata pre-filter + ANN-on-subset reduces this mismatch and lowers noisy context injection.

5) Implementation Plan (phased) + Complexity + Risks
Phase	Scope	Complexity	Risk
Phase 0	Add filter telemetry fields (selected filters, candidate counts, fallback reason)	S	Low
Phase 1	Add metadata schema + enforce write-path metadata on new uploads	M	Medium
Phase 2	Add metadata_filters to /search/hybrid and apply in Chroma retrieval	M	Medium
Phase 3	Update worker retrieval orchestration to staged flow + fallback ladder	M	Medium
Phase 4	Reindex/backfill Solr + Chroma metadata parity check	L	Medium-High
Phase 5	A/B in staging with rollback flag	S	Low
6) Go / No-Go Recommendation
Recommendation: GO, but only as flagged staged rollout.

Conditions:

Keep current pipeline as fallback (RAG_STAGED_HYBRID_FILTERING=0/1).
Add hard observability on filter selectivity and empty-result fallbacks.
Validate with controlled A/B before production default.
7) Bench/PoC Plan
Benchmark query set (include smell test)
“How do I request a new office access card and parking slot?”
“Where is the head-office parking request procedure?”
“What is the process for replacing a lost access card?”
“Q4 2025 cloud costs” (smell test: older irrelevant docs should not dominate)
10 additional real internal prompts from recent logs.
Dataset slice
Slice A: full active corpus (all departments).
Slice B: HR+GA only.
Slice C: known policy subset with clear ground truth.
A/B method
Same LLM model, same prompt template, same max tokens.
Only retrieval changes.
Run each query 5-10 times to smooth variance.
Collect p50/p95 retrieval + total latency, precision proxy, context tokens.
Success criteria
Retrieval p95 improvement >= 30%
Total latency p95 improvement >= 15%
Precision@3 improvement >= 20% (proxy allowed)
Recall@5 no worse than -2% vs baseline
Context token reduction >= 35%
No RBAC violations, no increase in empty-answer failures
Stop conditions
Recall drop > 5% without compensating precision gain
Frequent empty-result fallback loops
Any access-scope leakage
Proceed with implementation?
If you approve, I will change exactly these areas:

[/home/qabot/hrbot/api/src/queue/chatGenProcess.ts] — add Stage 1 filter planner, Stage 2 filtered ANN call, Stage 3 post-filter/fallback ladder, and telemetry fields.
[/home/qabot/hrbot/rag/models/schemas.py] — extend HybridSearchRequest with metadata_filters / candidate_file_ids.
[/home/qabot/hrbot/rag/services/HybridRAGEngineFactory.py] — apply metadata filters to vector/hybrid retrieval path.
[/home/qabot/hrbot/api/src/service/fileUploadService.ts] and ingest path(s) — ensure required filter metadata is indexed consistently for new docs.
[/home/qabot/hrbot/api/src/tools/reindexSolr.ts] (+ optional new backfill script) — metadata backfill/reindex for existing corpus.
Observability glue in [/home/qabot/hrbot/api/src/service/analyticsService.ts] (and optionally metrics route) for staged-filter KPIs.
Proceed with implementation?
