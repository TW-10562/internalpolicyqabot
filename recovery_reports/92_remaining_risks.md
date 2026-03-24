# Remaining Risks

1. The worker is healthy and retrieval is healthy, but some uncached LLM generations can still hit upstream timeouts and require retry. During final post-restart validation, a unique query completed successfully only after one 60000ms timeout and retry, with total LLM time around 89s.
2. `query_intent_rules.json`, `rag_term_map.json`, and `rag_termbase.json` are still missing, so all queries default to `rag_query` and some optional query-shaping features stay disabled.
3. APISIX still likely contains stale historical objects. They were intentionally not deleted without a full blast-radius review.
4. Direct gateway responses from `gpt-oss:20b` may sometimes consume the token budget in `reasoning` instead of `message.content`; the endpoint is reachable and returns 200, but client-side handling should tolerate that shape.
5. The unrelated SSO duplicate-`emp_id` defect remains open in the API service.
