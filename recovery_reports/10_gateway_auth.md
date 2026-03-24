# Gateway And Auth

## Findings

- `GET /v1/models` and `POST /v1/chat/completions` both resolve through APISIX and remain reachable with the live `key-auth` header strategy.
- The live application runtime uses `LLM_API_KEY` with header name `apikey` as the source of truth.
- Functional checks confirmed:
  - auth failure without key on `/v1/models`
  - auth success with key on `/v1/models`
  - auth success with key on `/v1/chat/completions`
- APISIX still appears to contain stale historical routes or consumers, but they were left untouched because removing them without a full dependency map would be riskier than isolating them.

## Operational conclusion

- Gateway routing is usable and consistent for the live model backend.
- The runtime app key and header strategy are aligned with the current API and worker containers.
- Safe cleanup decision: document stale APISIX objects, do not delete them during recovery.
