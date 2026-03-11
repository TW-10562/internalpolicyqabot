# Mini Verified Storage & Access Report

Last verified: 2026-02-18 (local workspace state)

## 1) Runtime services and ports

| Component | Port | Backing store / notes |
|---|---:|---|
| UI (`ui-2`, Vite) | `7001` | Proxies `/dev-api/*` to API |
| API (`api`, Koa) | `8080` | Main auth, RBAC, admin, triage endpoints |
| RAG API (`rag`, FastAPI) | `8010` | Retrieval / ingestion engine |
| FAQ Cache API (optional) | `8001` | Optional cache service target only |
| Bull Board | `9999` | Queue monitor UI |
| PostgreSQL (Docker) | `5432` | Primary persisted relational data |
| Redis (Docker) | `6379` | Session/cache/sets/counters |
| Solr (Docker) | `8983` | Search core `mycore` |

Verified from: `config/default.yml`, `docker-compose.yml`, `ui-2/vite.config.ts`, `api/src/main.ts`.

## 2) Which DB is actually used

- API chooses DB mode dynamically in `api/src/db/adapter.ts`.
- If required Postgres tables exist (`sys_user`, `sys_role`, `sys_menu`, `sys_user_role`, `sys_role_menu`), mode is `postgres`.
- Current environment is running with PostgreSQL tables present (verified by direct table listing).
- Sequelize config also prioritizes Postgres when PG env vars exist (`api/src/mysql/db/seq.db.ts`).

## 3) What is stored where

### PostgreSQL (`qa_db`)

Current public tables (verified):

- `user`, `user_role`, `group`, `user_group`
- `sys_user`, `sys_role`, `sys_menu`, `sys_user_role`, `sys_role_menu`
- `role`, `role_menu`, `menu`-equivalent via `sys_menu`/legacy
- `file`, `file_tag`, `file_role`
- `krd_gen_task`, `krd_gen_task_output`
- `chat_history_conversations`, `chat_history_messages`
- `messages`, `notifications`, `app_notifications`, `support_tickets`
- `triage_tickets`, `triage_payload`, `audit_logs`, `departments`
- `schema_migrations`, `sso_user_bind`, `flow_definitions`

Current row snapshot (verified now):

- `user`: `5`
- `triage_tickets`: `0`
- `triage_payload`: `0`
- `audit_logs`: `4`
- `messages`: `0`
- `notifications`: `0`
- `support_tickets`: `0`

### Redis

Used by API for:

- Login sessions:
  - Set `login_tokens` (session ids)
  - Per-session JSON value keyed by session hash
- TTL management for session keys
- Misc cache/sets:
  - `menu_message`
  - `update_userInfo` set
  - `ollama_api_weight_set` zset
- Simple counters: `set`, `get`, `sadd`, `srem`, etc.

Verified from: `api/src/clients/redis.ts`, `api/src/utils/auth.ts`, `api/src/utils/redis.ts`.

### Filesystem persistence

- Uploaded files:
  - `uploads/files` (served statically by API)
- RAG vector store path:
  - `rag/app/rag_db` (Chroma persistent path in config)
- Docker persistent volumes:
  - Postgres data: `data/volumes/data/postgres-data`
  - Redis data: `data/volumes/data/redis-data`
  - Solr data: `data/volumes/data/solr-data`

Verified from: `config/default.yml`, `api/src/main.ts`, `docker-compose.yml`, directory checks.

## 4) Endpoint map (relevant to escalation/triage + auth)

### UI to API pathing

- UI base path for API calls: `/dev-api` (`ui-2/src/api/request.ts`)
- Vite proxy target: `http://127.0.0.1:8080` by default (`ui-2/vite.config.ts`)

### Auth

- `POST /api/auth/login` (employeeId + password)
- `POST /api/auth/logout`

Route source: `api/src/routes/apiAuth.ts`, controller: `api/src/controller/apiAuth.ts`.

### Triage / Escalation

- `POST /api/triage/tickets`
- `GET /api/triage/tickets?pageNum=&pageSize=`
- `PATCH /api/triage/tickets/:id/status`

Route source: `api/src/routes/triage.ts`, service: `api/src/service/triageService.ts`.

### Admin user management

- `GET /api/admin/users`
- `POST /api/admin/users`
- `PUT /api/admin/users/:userId`
- `DELETE /api/admin/users/:userId`
- `POST /api/admin/users/import-csv`

Route source: `api/src/routes/adminUsers.ts`.

## 5) Credentials and access data (currently verified)

### Infrastructure credentials (dev config)

- PostgreSQL:
  - DB: `qa_db`
  - User: `twave_01`
  - Password: `twave_01password`
- Redis:
  - Host: `localhost`
  - Port: `6379`
  - Password: `abcd1234`

Source: `docker-compose.yml`, `config/default.yml`, `.env.example`.

### App login credentials (verified)

- Confirmed working hash match:
  - `employeeId: admin`
  - `password: 12345`

Known current users in DB:

| user_id | user_name | emp_id | department_code | role_code | status |
|---:|---|---|---|---|---:|
| 1 | admin | admin | HR | USER | 1 |
| 2 | hari krishnan | 10562 | HR | USER | 1 |
| 3 | HR Admin | 12345 | HR | HR_ADMIN | 1 |
| 4 | GA Admin | 456789 | GA | GA_ADMIN | 1 |
| 5 | ACC Admin | 963852 | ACC | ACC_ADMIN | 1 |

Notes:

- Passwords are stored hashed (bcrypt) and are not readable from DB.
- Only credentials explicitly validated here should be treated as guaranteed.

## 6) Escalation flow data path

1. UI sends request through `/dev-api/api/triage/*`.
2. API validates JWT + scoped access (`requireScopedAccess`).
3. API writes ticket metadata to `triage_tickets`.
4. API writes ticket payload to `triage_payload`.
5. API emits audit entries into `audit_logs`.
6. API can emit notifications to admin users (`notifications` / `app_notifications` path via service).

## 7) Commands used for verification

Examples run during verification:

- List tables:
  - `docker exec -i expobot_impl-postgres-1 psql -U twave_01 -d qa_db -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;"`
- Snapshot table counts:
  - `docker exec -i expobot_impl-postgres-1 psql -U twave_01 -d qa_db -c "SELECT ..."`
- Snapshot users/roles:
  - `docker exec -i expobot_impl-postgres-1 psql -U twave_01 -d qa_db -c "SELECT ... FROM \"user\" ..."`
