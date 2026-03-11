# Internal Policy QA Bot

Internal Policy QA Bot is a multi-service enterprise knowledge assistant for internal policy, HR, and operational Q&A. It combines a role-aware web application, a Node.js orchestration API, and a Python Retrieval-Augmented Generation (RAG) service backed by Solr, PostgreSQL, Redis, and an OpenAI-compatible LLM gateway.

## Overview

This repository provides the full application stack used to:

- answer internal policy and procedure questions through a chat UI
- upload and index internal documents for retrieval
- enforce role-based access for admin and end-user workflows
- track analytics, history, notifications, and support operations
- run multilingual and retrieval-enhanced answer generation
- support Azure AD SSO alongside application-level authentication

## Core Capabilities

- Role-based frontend for chat, login, admin views, analytics, and notifications
- Document ingestion for PDF, DOC, and DOCX content
- Hybrid search and vector-assisted retrieval pipelines
- Query normalization, translation, reranking, and grounding
- Background job processing and Bull Board monitoring
- PostgreSQL-backed application state and Redis-backed queues/cache
- Optional FAQ cache service for fast semantic lookup
- Evaluation scripts for RAG regression and quality gating

## System Architecture

```text
Browser (React + Vite UI)
        |
        v
Koa API (TypeScript)
  - authentication and RBAC
  - file upload and admin workflows
  - history, notifications, analytics
  - query orchestration and job dispatch
        |
        +--> OpenAI-compatible LLM gateway
        |
        v
FastAPI RAG service (Python)
  - ingestion, chunking, retrieval, grounding
        |
        +--> Solr core (`mycore`)
        +--> vector store / local RAG data
        +--> optional FAQ cache service

Shared infrastructure
  - PostgreSQL for users, metadata, history, and admin data
  - Redis for queues and transient application state
```

## Repository Structure

- `api/` - Koa/TypeScript backend, routes, services, queues, and PostgreSQL migrations
- `ui-2/` - React/Vite frontend for login, chat, notifications, and admin screens
- `rag/` - FastAPI-based RAG service for ingestion, embeddings, retrieval, and generation support
- `faq_database/` - optional semantic FAQ cache service
- `aviary/` - Aviary integration assets and starter-kit modules
- `config/` - shared runtime configuration consumed by the API and RAG services
- `docs/` - operational notes including Azure AD SSO guidance
- `architecture/` - Mermaid diagrams and exported architecture images
- `uploads/` - local document upload storage used by the RAG pipeline

## Main Services

### Frontend

The UI lives in `ui-2/` and is built with React, TypeScript, and Vite. It provides:

- login and session handling
- chat and history views
- admin dashboards
- notifications and support-related screens

### API

The backend lives in `api/` and is built with Koa and TypeScript. It is the main orchestration layer for:

- authentication and access control
- user, role, group, and menu management
- document upload and retrieval endpoints
- analytics, notifications, support, and triage workflows
- chat, translation, and RAG request routing
- background jobs through Bull and Bull Board

The API automatically runs PostgreSQL migrations from `api/src/db/migrations/postgres/` on startup.

### RAG Service

The Python service lives in `rag/` and is responsible for:

- document ingestion
- chunking and preprocessing
- retrieval and reranking
- grounding support for final answers
- Solr and vector-store interaction

By default, local RAG startup assumes GPU availability. For CPU-only local debugging, set `RAG_FORCE_GPU_ONLY=0`.

### Optional FAQ Cache

`faq_database/` contains a separate FastAPI service that can serve semantic FAQ hits before a full RAG path. It is optional and typically runs on port `8001`.

## Technology Stack

- Frontend: React 18, TypeScript, Vite, Tailwind CSS
- API: Node.js, Koa, TypeScript, Bull, PostgreSQL, Redis
- RAG: FastAPI, PyTorch, Hugging Face models, Solr, local vector store
- Infra: Docker Compose, PostgreSQL, Redis, Solr, OpenAI-compatible LLM gateway

## Configuration Model

The project uses multiple configuration files because different services can be run independently.

### Environment Files

- `.env` - shared root environment values used by root-level tooling and the RAG service bootstrap
- `api/.env` - API-specific runtime variables
- `ui-2/.env` - Vite frontend development variables
- `rag/.env` - RAG service runtime overrides
- `config/default.yml` - shared application configuration with `${ENV}` interpolation and `<PROJECT_ROOT_DIR>` templating
- `config.example.yml` - reference template for the shared YAML configuration

### Initial Setup

Create local environment files from the included examples:

```bash
cp .env.example .env
cp api/.env.example api/.env
cp ui-2/.env.example ui-2/.env
cp rag/.env.example rag/.env
```

After copying them, review the values before starting the stack.

### Important Port and Environment Notes

This repository contains more than one environment template because it supports multiple deployment styles. Align the values before running services.

- `docker-compose.yml` exposes PostgreSQL on `55432`, Redis on `16379`, Solr on `8983`, RAG on `8010`, the LLM gateway on `8000`, and the API on `3000`
- the root `.env.example` assumes a local API on `8080`, PostgreSQL on `5432`, and Redis on `6379`
- `api/.env.example` includes another profile that points PostgreSQL to `5433` and the LLM gateway to `9080`
- the UI defaults to `http://localhost:8080` for API access during local development

If you use the included Docker Compose stack, update your local env files so each service points to the correct host ports.

### Docker Volume Paths

The root `docker-compose.yml` uses absolute host volume paths under `/srv/tbot/...`. Update those paths if your machine does not use that directory layout.

## Running the Project

You can start the project either as source-based local development or as a mostly containerized stack.

### Option 1: Bootstrap with the Helper Script

The repo includes `dev-init.sh`, which:

- starts Docker services
- creates missing `.env` files from examples
- installs API, UI, and RAG dependencies
- adds expected Solr schema fields used by the project

Run it from the repository root:

```bash
./dev-init.sh
```

### Option 2: Manual Local Development

#### 1. Start infrastructure services

If you want to run the application services from source, start the supporting services first:

```bash
docker compose up -d redis postgres solr llm-gateway
```

If you also want the Python RAG service in Docker, include `rag-python`.

#### 2. Start the RAG service

```bash
cd rag
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Default local URL:

```text
http://localhost:8010
```

#### 3. Start the API

```bash
cd api
pnpm install
pnpm dev
```

Optional worker process:

```bash
cd api
pnpm worker
```

Worker concurrency (defaults to FIFO, `1`):

```bash
# Increase parallel chat generation jobs per worker process
CHAT_QUEUE_CONCURRENCY=4 pnpm worker

# Optional: log per-job queue wait/run time
QUEUE_LOG_TIMING=1 pnpm worker
```

Default local URLs:

```text
API: http://localhost:8080
Bull Board: http://localhost:9999
```

#### 4. Start the UI

```bash
cd ui-2
pnpm install
pnpm dev
```

Default local URL:

```text
http://localhost:7001
```

### Option 3: Containerized Stack

The root Docker setup can build and run most backend services:

```bash
docker compose up -d --build
```

This starts:

- Redis
- PostgreSQL
- Solr
- Python RAG service
- OpenAI-compatible LLM gateway
- API container

The Dockerfile also includes a `ui` target, but the current `docker-compose.yml` does not launch a UI container by default.

## Authentication and Access

The application supports:

- application login flows exposed by the API
- employee-id-based login endpoints
- Azure AD SSO callback and token exchange flows

See `docs/azure-ad-sso-guide.md` for Azure AD setup guidance.

## Documents and Retrieval

The shared config currently defines preprocessing support for:

- PDF
- DOC
- DOCX

Uploads are stored under the project `uploads/` area unless overridden by environment variables and YAML config.

Default Solr core name:

```text
mycore
```

## Useful Development Commands

### API

```bash
cd api
pnpm dev
pnpm worker
pnpm dev:all
pnpm test:rag
pnpm test:rag:pipeline
pnpm eval:rag:core
pnpm eval:rag:gate
```

### UI

```bash
cd ui-2
pnpm dev
pnpm build
pnpm typecheck
```

### RAG

```bash
cd rag
python main.py
```

## Related Documentation

- `docs/azure-ad-sso-guide.md` - Azure AD application and SSO setup
- `architecture/` - architecture diagrams and exports
- `faq_database/README.md` - FAQ cache service details
- `aviary/README.md` - Aviary-related starter documentation

## Troubleshooting

- If the UI cannot reach the backend, confirm `ui-2/.env` and the API port match the running API instance
- If the API cannot boot, verify PostgreSQL and Redis connection settings and confirm the database is reachable
- If the RAG service fails immediately on a non-GPU machine, set `RAG_FORCE_GPU_ONLY=0`
- If Solr-based retrieval fails, confirm the `mycore` core exists and required schema fields have been added
- If Docker services fail to mount storage, replace the `/srv/tbot/...` host paths in `docker-compose.yml`
- If services appear to start on the wrong ports, reconcile the different `.env.example` files before retrying
