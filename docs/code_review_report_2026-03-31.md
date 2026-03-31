# Code Review Report

Date: 2026-03-31
Reviewer: Codex
Workspace: `/home/qabot/hrbot`

## Scope

This review covered the current project folder as it exists on disk, not just git-tracked files.

- Repo-visible inventory: 543 non-ignored files from `rg --files`
- Extra runtime artifacts also present: uploaded documents in `uploads/`, vector-store/model data in `rag/app/` and `rag/data/`, backup material in `archive/` and `backup_recovery/`
- Working tree status at review time: multiple modified backend/frontend files plus one new migration file already present before any review edits

Because this repository contains large binary/runtime corpora, the review was split into:

- Manual source/config/script inspection for application code and operational files
- Validation runs for TypeScript, Python syntax, and live service health
- Inventory and categorization of non-code/runtime files rather than line-by-line semantic review of every uploaded PDF/DOC/binary

## Executive Summary

The application is structurally coherent and the main services do start: API health, RAG health, frontend typecheck, backend typecheck, and the RAG embedding self-check all passed. The biggest risks are not "it does not boot", but security and correctness:

- a real RSA private key is committed in the repository
- RAG file/metadata filters are dropped on empty matches, which can expand retrieval outside the intended scope
- the notification read endpoint accepts arbitrary IDs and reports success even when nothing valid was updated
- support reply notifications can be written to the wrong department and become invisible to end users

Operationally, the validation/tooling story is weaker than the runtime story:

- the repo healthcheck fails on a healthy-but-empty Solr core and references helper scripts that are missing
- frontend linting crashes before it reaches application code
- backend linting is not runnable as configured because there is no ESLint config file

## Findings

### 1. Critical: A valid RSA private key is committed in the repository

Files:

- `ssl-vendor/newkey.pem`

Why this matters:

- The file is git-tracked and `openssl rsa -in ssl-vendor/newkey.pem -check -noout` returned `RSA key ok`.
- This is a live private key artifact in repository history, not just a placeholder.
- Even if the certificate is no longer in use, the key must be treated as compromised.

Impact:

- Anyone with repository access or historical clones may have the private key.
- If it matches a deployed certificate anywhere, TLS trust for that endpoint is compromised.

Recommended action:

- Rotate the certificate/key pair immediately.
- Remove the key from the repository and purge it from git history.
- Audit whether any other key, cert bundle, or vendor secret is stored under `ssl-vendor/`.

### 2. High: RAG retrieval silently drops metadata/file-scope filters when they produce zero results

Files:

- `rag/services/HybridRAGEngineFactory.py:263`
- `rag/services/HybridRAGEngineFactory.py:269`
- `rag/services/HybridRAGEngineFactory.py:283`
- `rag/services/HybridRAGEngineFactory.py:293`
- `api/src/rag/retrieval/vectorRetriever.ts:160`
- `api/src/rag/retrieval/vectorRetriever.ts:174`
- `api/src/rag/pipeline/ragPipeline.ts:1339`

What happens:

- Vector-only mode retries without `where_filter` when a filtered query returns zero documents.
- BM25/hybrid mode falls back to the entire cached corpus when the metadata pre-filter returns zero documents.
- Upstream code passes `candidate_file_ids` and `metadata_filters` specifically to constrain retrieval.

Why this matters:

- This defeats the caller's requested scope.
- At minimum it breaks retrieval correctness and makes debugging impossible.
- If `fileScopeIds` or metadata filters are also used for document authorization or department scoping, it can leak documents outside the allowed set.

Recommended action:

- Treat an empty filtered result as a valid empty result, not a signal to widen scope.
- Only relax filters when an explicit caller-controlled flag allows it, and log that decision as a retrieval policy event.

### 3. High: Notification read endpoint allows arbitrary IDs and always returns success

Files:

- `api/src/routes/notifications.ts:124`
- `api/src/service/notificationService.ts:142`
- `api/src/service/notificationService.ts:161`
- `api/src/db/migrations/postgres/014_add_notification_reads.sql`

What happens:

- `PATCH /api/notifications/:id/read` forwards any numeric ID to `markNotificationAsRead`.
- `markNotificationAsRead` inserts into `notification_reads` without checking that the notification exists or is visible to the user.
- The service returns `updated > 0 || true`, which is effectively always `true`.
- The migration creates `notification_reads` without a foreign key to `app_notifications`.

Why this matters:

- Any authenticated user can mark arbitrary notification IDs as read in their own read-tracking table.
- The route cannot distinguish success, not-found, or unauthorized cases.
- Client state can drift from server truth and bugs will be hard to detect because the API always says "ok".

Recommended action:

- First verify the notification exists and is visible to the acting user.
- Add a foreign key if cross-database constraints are not a blocker, or perform a validated existence check before insert.
- Return `false` or `NOT_FOUND` when nothing visible was updated.

### 4. Medium: Support replies can be stored under the admin's department instead of the ticket owner's department

Files:

- `api/src/routes/support.ts:98`
- `api/src/routes/support.ts:102`
- `api/src/service/supportTicketService.ts:63`
- `api/src/service/supportTicketService.ts:78`
- `api/src/service/supportTicketService.ts:80`

What happens:

- The route passes `scope.departmentCode` from the replying admin into `replyToTicket`.
- The service uses that department code when writing the user's notification row, instead of the original ticket's department.

Why this matters:

- Super admins can see all tickets, so cross-department replies are allowed.
- User-side notification reads are filtered by the user's department code.
- A reply to an HR user's ticket can be saved under `OTHER` or another admin department and then never appear for the target user.

Recommended action:

- Use `ticket.department_code` for the notification recipient row.
- Treat the admin's department only as actor metadata, not as the target notification scope.

### 5. Medium: The healthcheck script gives false negatives and references missing helper scripts

Files:

- `scripts/healthcheck_all.sh:52`
- `scripts/healthcheck_all.sh:57`
- `scripts/healthcheck_all.sh:61`
- `scripts/healthcheck_all.sh:62`

Observed behavior:

- `bash scripts/healthcheck_all.sh` failed after the Solr step.
- API and RAG health were both `ok`.
- Solr responded successfully but returned `numFound: 0`, which the script treats as a hard failure.
- `scripts/test_gateway.sh` and `scripts/test_rag_e2e.sh` are not present in `scripts/`.

Why this matters:

- A fresh or empty environment is reported as unhealthy even when the services are up.
- The script cannot complete even after the Solr issue is fixed because it calls missing helpers.

Recommended action:

- Separate "infrastructure up" checks from "data loaded" checks.
- Replace the `numFound > 0` requirement with a weaker Solr responsiveness assertion unless seeded data is mandatory.
- Restore or remove the missing helper scripts.

### 6. Medium: Frontend linting is currently broken by toolchain incompatibility

Files:

- `ui-2/package.json:12`
- `ui-2/package.json:28`
- `ui-2/package.json:35`
- `ui-2/eslint.config.js:7`

Observed behavior:

- `./node_modules/.bin/eslint .` crashes before linting application code with:
  `TypeError: Class extends value undefined is not a constructor or null`

Why this matters:

- The frontend has no working lint gate right now.
- This makes it harder to catch unused values, hook mistakes, and typing regressions early.

Inference:

- The failure is consistent with an incompatible ESLint/plugin stack in the currently installed dependency set.

Recommended action:

- Align `eslint`, `typescript-eslint`, and related plugin versions to a known-compatible set.
- Keep one lockfile and one package manager for `ui-2` to reduce dependency drift.

### 7. Low: Backend linting is not runnable as configured

Files:

- `api/package.json:8`

Observed behavior:

- The configured lint script is `npx eslint src/** --fix`.
- Running ESLint directly fails because there is no config file in `api/`.
- The script also uses `--fix`, which is undesirable for CI/read-only validation.

Why this matters:

- The backend has no dependable lint check in its current state.
- A reviewer or CI job cannot safely run lint without mutating files.

Recommended action:

- Add an ESLint config for `api/`.
- Split lint into read-only and fix modes, for example `lint` and `lint:fix`.

### 8. Low: README repository map is stale

Files:

- `README.md:56`
- `README.md:59`
- `README.md:60`

Observed behavior:

- The README lists top-level `faq_database/` and `aviary/` directories.
- In the current project folder, those live under `archive/legacy/` instead of the repository root.

Why this matters:

- New contributors will look in the wrong place for optional/legacy services.
- Operational docs drift makes setup and debugging slower.

Recommended action:

- Update the repo map to reflect the current folder layout and explicitly label archived modules as inactive.

## Validation Results

### Passed

- Backend TypeScript compile: `./node_modules/.bin/tsc --noEmit -p tsconfig.json`
- Frontend TypeScript compile: `./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
- RAG Python syntax check on application code: `python3 -B -m py_compile ...` excluding `rag/data/` model artifacts
- Live API health: `GET http://127.0.0.1:8080/health` returned `status=ok`, Postgres available
- Live RAG health: `GET http://127.0.0.1:8010/health` returned `status=ok`
- Live embedding self-check: `POST http://127.0.0.1:8010/check_embedding_model` succeeded

### Failed or Limited

- Frontend ESLint crashed before code analysis
- Backend ESLint could not run due missing config
- Repo healthcheck script failed at Solr validation
- Solr was reachable, but `mycore` currently reported `numFound: 0`

## Project Map And File Usage Summary

### Root files

- `README.md`: primary architecture and setup guide
- `Dockerfile`: container build for application services
- `docker-compose.yml` and `docker-compose.override.yml`: local/service orchestration
- `dev-init.sh`: bootstrap helper for local environments
- `setup-database.sh`: database preparation helper
- `install-hrbot-client.sh` and `install-hrbot-client.ps1`: client install/bootstrap helpers
- `config.example.yml`: sample shared YAML configuration

### `config/`

- Shared runtime config and retrieval/domain rule data used by API and RAG
- `default.yml`: active local/shared runtime config loader target
- `ng-words.json`: moderation or blocked-term data
- `rag_domain_rules.json`, `rag_term_map.json`, `rag_termbase.json`: RAG routing/query normalization dictionaries

### `api/`

- Main Node/Koa backend
- `src/main.ts`: startup/bootstrap
- `src/routes/`: HTTP surface for auth, history, notifications, files, triage, support, analytics, queries
- `src/service/`: business logic, RBAC, history persistence, notifications, support, inference, OpenAI client
- `src/rag/`: API-side retrieval/generation pipeline, language routing, reranking, prompt building
- `src/db/migrations/postgres/`: schema evolution scripts
- `src/queue/`: async processing for chat, translation, summary, file ingestion
- `src/mysql/` and `src/postgres/`: ORM/database compatibility layer
- `scripts/`: RAG evaluation, optional dependency management, migration helpers

### `ui-2/`

- React/Vite frontend
- `src/App.tsx`: top-level session, notifications, routing-by-state
- `src/api/`: browser clients for backend endpoints
- `src/components/chat/`: main chat UX, history view, export, citations
- `src/components/admin/`: document, user, analytics, triage, and admin workflow UI
- `src/components/notifications/`: notification center UI
- `src/context/`: language, theme, toast providers
- `src/translations/`: English/Japanese UI strings
- `eslint.config.js`, `tsconfig*.json`, `vite.config.ts`: frontend toolchain config

### `rag/`

- Python FastAPI RAG service
- `main.py`: process bootstrap and bind-host handling
- `api/main.py`: FastAPI routes for search/update/delete/health
- `config/`: Pydantic-backed config loading and validation
- `services/`: embeddings, hybrid retrieval, reranking, document/record operations
- `repositories/`: Chroma interaction layer
- `utils/`: Solr helpers, text extraction, text splitting, search helpers
- `scripts/`: bulk loading and re-embedding utilities
- `app/`, `backups/`, `data/model/`: local vector stores, backups, and model artifacts rather than source code

### `docker/`

- Nginx/UI bootstrap configuration and example HTTP/HTTPS site configs

### `scripts/`

- Benchmarking, migration, cleanup, healthcheck, and Solr maintenance helpers

### `docs/`

- SSO, environment, deployment, storage, RAG, and operations notes

### `architecture/`

- Mermaid diagrams and one exported PNG for system design/reference

### `archive/`

- Archived legacy services and recovery/backfill documentation
- Not part of the active runtime path

### `backup_recovery/`

- Recovery leftovers and old helper backups
- Not part of active runtime; useful for ops forensics only

### `data/`

- Runtime/local application state
- `data/sso_roles.sqlite` appears to be a local database artifact, not source code

### `uploads/`

- Document corpus used by the RAG pipeline
- This directory contains user/business content, not application logic

### `ssl-vendor/`

- Vendor certificate/key material
- Should be treated as sensitive operational material, not normal source

## Inventory Notes

High-level file counts from repo-visible files:

- `api/`: 250 files
- `rag/`: 91 files
- `archive/`: 82 files
- `ui-2/`: 71 files
- `docs/`: 11 files
- `architecture/`: 10 files
- `docker/`: 7 files
- `scripts/`: 6 files
- `ssl-vendor/`: 4 files
- `backup_recovery/`: 2 visible files plus additional backup artifacts on disk

Important distinction:

- Source review was deepest on `api/src`, `rag/`, `ui-2/src`, `config/`, `scripts/`, `docker/`, `docs/`, and migrations
- Binary assets, uploaded documents, local Chroma stores, and backup snapshots were inventoried and categorized, but not semantically code-reviewed file-by-file because they are runtime content rather than implementation

## Recommended Next Steps

1. Rotate and remove the committed RSA private key, then scrub repository history.
2. Fix the RAG filter fallback so retrieval never widens scope implicitly.
3. Correct notification read authorization and success reporting.
4. Fix support reply notification department targeting.
5. Repair validation tooling: frontend lint stack, backend ESLint config, healthcheck script.
6. Update docs to reflect the current repository layout and operational assumptions.
