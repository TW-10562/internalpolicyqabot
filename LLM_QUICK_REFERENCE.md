# LLM Migration - Quick Reference

## Environment Variables

### Set These in `.env`:
```env
# Required
LLM_BASE_URL=http://localhost:9080/v1    # Gateway endpoint
LLM_API_KEY=                               # Bearer token (leave empty if not required)
LLM_MODEL=gptoss20b                       # Model name
```

## Files Changed

| File | Status |
|------|--------|
| `api/src/service/openai_client.ts` | ✅ Central LLM client |
| `api/src/service/openai_client.ts` | ✅ Used by runtime LLM call sites |
| `api/.env` | ✅ Added LLM_* variables |
| `api/.env.example` | ✅ Replaced Ollama with LLM vars |
| `.env.shared` | ✅ Updated for deployments |
| `config/default.yml` | ✅ Added LLM section |
| `api/scripts/test_llm_gateway.ts` | ✅ NEW test script |
| `LLM_MIGRATION_GUIDE.md` | ✅ Full documentation |
| `MIGRATION_SUMMARY.md` | ✅ Complete change summary |
| `scripts/migrate_llm.sh` | ✅ Automated setup script |

## Commands

### Run Smoke Test
```bash
cd api
pnpm ts-node scripts/test_llm_gateway.ts
```

### Start All Services
```bash
bash scripts/migrate_llm.sh
```

### Manual Start
```bash
# Terminal 1: API Server
cd api && pnpm dev

# Terminal 2: Worker
cd api && pnpm worker
```

## Common Issues

| Error | Solution |
|-------|----------|
| `Connection refused to http://localhost:9080` | Start LLM gateway |
| `HTTP 401: Unauthorized` | Set correct `LLM_API_KEY` |
| `HTTP 404: Not Found` | Check gateway exposes `/v1/chat/completions` |
| `Empty response` | Check model is loaded on gateway |

## API Usage

### Non-Streaming
```typescript
const response = await openaiClient.generate(
  [{ role: 'user', content: 'Hello' }],
  { temperature: 0.7, max_tokens: 2048 }
);
console.log(response.content);
```

### Streaming
```typescript
for await (const chunk of openaiClient.generateStream(messages)) {
  console.log(chunk);
}
```

### Translation
```typescript
const ja = await openaiClient.translate('Hello', 'Japanese');
```

## Deprecated Ollama Variables (Remove Over Time)

```env
# ❌ OLD - Don't use anymore
OLLAMA_BASE_URL=...
OLLAMA_MODEL=...
OLLAMA_API=...
OLLAMA_TITLE_MODEL=...
OLLAMA_TRANSLATION_MODEL=...
```

## Verification Checklist

- [ ] `.env` has `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`
- [ ] Gateway is running at the specified URL
- [ ] Smoke test passes
- [ ] API server starts: `pnpm dev`
- [ ] Chat requests work
- [ ] Streaming works

## Reference Docs

- Migration Guide: [LLM_MIGRATION_GUIDE.md](../LLM_MIGRATION_GUIDE.md)
- Full Summary: [MIGRATION_SUMMARY.md](../MIGRATION_SUMMARY.md)
- Client Code: [api/src/service/openai_client.ts](../api/src/service/openai_client.ts)
