# Personal Dev Ports (Shared Server Safe)

This guide runs your own stack on alternate ports without touching the other developer's processes.

## Personal ports

- UI: `5174`
- API: `9091`
- RAG: `8002`

Shared services stay unchanged:
- Ollama: `11434` (or your existing gateway setup)
- Postgres: existing shared host/port
- Redis: existing shared host/port
- Solr: existing shared host/port

## 1) API (`9091`)

Run from `api/` with your own port and your RAG URL:

```bash
cd /home/qabot/hrbot/api
PORT=9091 \
RAG_BACKEND_URL=http://localhost:8002 \
RAG_SERVICE_URL=http://localhost:8002 \
RAG_BACKEND_PORT=8002 \
pnpm dev
```

Health check:

```bash
curl -fsS http://127.0.0.1:9091/health
```

## 2) RAG (`8002`)

Run from `rag/` with your own port:

```bash
cd /home/qabot/hrbot/rag
. .venv/bin/activate
RAG_BACKEND_HOST=127.0.0.1 \
RAG_BACKEND_PORT=8002 \
RAG_BACKEND_URL=http://localhost:8002 \
RAG_SERVICE_URL=http://localhost:8002 \
python main.py
```

Health check:

```bash
curl -fsS http://127.0.0.1:8002/health
```

## 3) UI (`5174`)

Run from `ui-2/` with your own UI port and API target:

```bash
cd /home/qabot/hrbot/ui-2
VITE_PORT=5174 \
VITE_API_BASE_URL=http://localhost:9091 \
pnpm dev
```

Open:
- `http://127.0.0.1:5174`

## 4) End-to-end quick check

```bash
curl -fsS http://127.0.0.1:9091/health
curl -fsS http://127.0.0.1:8002/health
```

Then test UI login/query from `http://127.0.0.1:5174`.

## Notes

- Do not stop or restart shared processes on default ports.
- Do not run your stack on `7001/8080/8010` when another developer is using them.
- These are runtime/env overrides only; app logic is unchanged.
