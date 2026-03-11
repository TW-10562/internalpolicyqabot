# syntax=docker/dockerfile:1.6
ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=9.12.3
ARG CUDA_IMAGE=pytorch/pytorch:2.3.1-cuda12.1-cudnn8-runtime
ARG RAG_BASE_IMAGE=condaforge/miniforge3:latest

FROM node:${NODE_VERSION}-bookworm-slim AS api-build
ARG NODE_VERSION
ARG PNPM_VERSION
WORKDIR /app/api
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
# copy only the project manifest and lockfile; workspace config is unnecessary and
# actually causes pnpm to treat /app/api as a workspace root, which fails because the
# workspace file lacks a "packages" entry.
COPY api/package.json api/pnpm-lock.yaml ./
# ensure we don't accidentally have a workspace file present
RUN rm -f pnpm-workspace.yaml || true
RUN pnpm install --no-frozen-lockfile
COPY api/tsconfig.json ./
COPY api/src ./src
COPY api/scripts ./scripts
COPY api/mcp-servers.json ./mcp-servers.json
RUN pnpm exec tsc -p tsconfig.json && pnpm exec tsc-alias -p tsconfig.json
RUN pnpm prune --prod

FROM node:${NODE_VERSION}-bookworm-slim AS api
ARG NODE_VERSION
ARG PNPM_VERSION
WORKDIR /app
ENV NODE_ENV=production
COPY --from=api-build /app/api/node_modules /app/api/node_modules
COPY --from=api-build /app/api/dist /app/api/dist
COPY --from=api-build /app/api/package.json /app/api/package.json
COPY --from=api-build /app/api/mcp-servers.json /app/api/mcp-servers.json
COPY api/src/db/migrations /app/api/dist/db/migrations
COPY config /app/config
EXPOSE 8080 9999
WORKDIR /app/api
CMD ["node", "dist/main.js"]

FROM ${RAG_BASE_IMAGE} AS rag
WORKDIR /app/rag
SHELL ["/bin/bash", "-lc"]
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/rag/data/model \
    TRANSFORMERS_CACHE=/app/rag/data/model \
    RAG_FORCE_GPU_ONLY=0
COPY rag/requirements.txt /app/rag/requirements.txt
RUN python - <<'PY'
from pathlib import Path
import re

src = Path('/app/rag/requirements.txt').read_text().splitlines()
skip = [
  r'^\\s*torch(\\s|==|>=|<=|$)',
]
filtered = [line for line in src if not any(re.match(pat, line) for pat in skip)]
Path('/app/rag/requirements.docker.txt').write_text("\n".join(filtered) + "\n")
PY
RUN conda create -y -n rag -c conda-forge python=3.11 pip pytorch compilers cmake make rust && conda clean -afy
ENV PATH=/opt/conda/envs/rag/bin:$PATH
RUN pip install --no-cache-dir -r /app/rag/requirements.docker.txt
COPY rag /app/rag
COPY config /app/config
EXPOSE 8010
CMD ["bash","-lc","python -c \"from services.gpu_guard import ensure_cuda_or_raise; ensure_cuda_or_raise('rag-api-startup')\" && python -m uvicorn api.main:app --host 0.0.0.0 --port 8010"]

FROM node:${NODE_VERSION}-bookworm-slim AS ui-build
ARG PNPM_VERSION
WORKDIR /app/ui-2
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY ui-2/package.json ui-2/pnpm-lock.yaml ./
RUN pnpm install --no-frozen-lockfile
COPY ui-2/ ./
RUN pnpm build

FROM nginx:1.27-alpine AS ui
COPY --from=ui-build /app/ui-2/dist /usr/share/nginx/html
RUN rm /etc/nginx/conf.d/default.conf && \
  cat <<'__NGINX__' > /etc/nginx/conf.d/default.conf
server {
  listen 7001;
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  client_max_body_size 1024m;

  # Docker DNS (so `api` resolves even after the api container is recreated)
  resolver 127.0.0.11 valid=10s ipv6=off;

  location /dev-api/ {
    set $api_upstream api;
    rewrite ^/dev-api/(.*)$ /$1 break;
    proxy_pass http://$api_upstream:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600;
  }

  location / {
    try_files $uri /index.html;
  }
}
__NGINX__
EXPOSE 7001
