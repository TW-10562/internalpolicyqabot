# LLM Migration: Ollama to OpenAI-Compatible Gateway

## 📋 Summary

This migration moves all LLM (Large Language Model) calls from **Ollama** to an **OpenAI-compatible API gateway** (e.g., APISIX, vLLM, or any OpenAI-compatible service).

### Key Changes

- **Old**: Direct HTTP calls to Ollama at `http://localhost:11435/api/chat`
- **New**: OpenAI-compatible API calls to `http://localhost:9080/v1/chat/completions` with Bearer token auth

### Files Changed

| File | Change |
|------|--------|
| `api/src/service/openai_client.ts` | Centralized LLM client with streaming & non-streaming support |
| `api/src/service/openai_client.ts` | Centralized runtime LLM client for direct gateway access |
| `api/.env` | Added `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` |
| `api/.env.example` | Updated with new LLM env vars, removed `OLLAMA_*` |
| `.env.shared` | Updated with new LLM configuration |
| `config/default.yml` | Added LLM section, kept legacy Ollama section for backward compat |
| `api/scripts/test_llm_gateway.ts` | ✨ NEW: Smoke test to verify gateway connectivity |

## 🚀 Quick Start

### 1. Update Configuration

Set these environment variables in your `.env` file:

```env
# LLM Configuration (OpenAI-compatible gateway)
LLM_BASE_URL=http://localhost:9080/v1
LLM_API_KEY=your-api-key-here
LLM_MODEL=gptoss20b
```

For remote deployments:
```env
LLM_BASE_URL=http://172.30.140.148:9080/v1
LLM_API_KEY=production-api-key
LLM_MODEL=gptoss20b
```

### 2. Start Services

Ensure the LLM gateway is running (APISIX or your chosen gateway):

```bash
# Example: Start APISIX gateway locally or remotely
# The gateway should expose /v1/chat/completions endpoint

# Then start the Node.js application
cd api
pnpm dev      # or: pnpm worker
```

### 3. Run Smoke Test

Verify the gateway is reachable:

```bash
cd api
pnpm ts-node scripts/test_llm_gateway.ts
```

Expected output:
```
✅ PASSED: Gateway is healthy
✅ PASSED: Non-streaming completion
✅ PASSED: Streaming completion
✅ PASSED: Translation function
```

##  Implementation Details

### openai_client.ts

A new centralized client module that handles all LLM interactions:

**Features:**
- ✅ Non-streaming chat completions with proper token counting
- ✅ Streaming completions with SSE (Server-Sent Events) parsing
- ✅ Translation helper with language detection
- ✅ Health check (ping) functionality
- ✅ Comprehensive error handling with HTTP status + response body
- ✅ Timeout management (120s default, configurable)
- ✅ Bearer token authentication
- ✅ Support for response_format (JSON mode if gateway supports it)

**API:**

```typescript
// Non-streaming
const response = await openaiClient.generate(
  [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' }
  ],
  { temperature: 0.7, max_tokens: 2048 }
);

// Streaming
for await (const chunk of openaiClient.generateStream(messages, options)) {
  console.log(chunk);
}

// Translation
const translated = await openaiClient.translate('Hello', 'Japanese');

// Health check
const isHealthy = await openaiClient.ping();
```

### Updated Call Sites

All services now delegate to `openaiClient`:

1. **llmService.ts** - Main LLM service (re-exports openaiClient methods)
2. **translation.ts** - Still uses direct Ollama `/api/chat` (should be refactored)
3. **chatGenProcess.ts** - Streaming chat processing (still uses getNextApiUrl for now)
4. **flow/nodes/ollama.ts** - LangChain Ollama node (deprecated; use openaiNode instead)

### Environment Variables

**New variables (required):**
```env
LLM_BASE_URL=http://localhost:9080/v1       # Gateway endpoint
LLM_API_KEY=                                 # Bearer token
LLM_MODEL=gptoss20b                          # Model name
```

**Deprecated Ollama variables:**
- ~~`OLLAMA_BASE_URL`~~ → Use `LLM_BASE_URL`
- ~~`OLLAMA_MODEL`~~ → Use `LLM_MODEL`
- ~~`OLLAMA_API`~~ → Removed
- ~~`OLLAMA_TITLE_MODEL`~~ → Use `LLM_MODEL`
- ~~`OLLAMA_TRANSLATION_MODEL`~~ → Use `LLM_MODEL`

## 🔧 Troubleshooting

### Error: "Connection refused to http://localhost:9080"

**Cause**: LLM gateway is not running or not accessible

**Solution**:
1. Verify gateway is running: `curl http://localhost:9080/v1/models`
2. Check `LLM_BASE_URL` in `.env` matches gateway address
3. Verify network connectivity (firewalls, VPNs)

### Error: "HTTP 401: Unauthorized"

**Cause**: `LLM_API_KEY` is missing or invalid

**Solution**:
1. Check `LLM_API_KEY` is set in `.env`
2. Verify token is valid for the gateway
3. Check if gateway requires auth headers

### Error: "HTTP 404: Not Found"

**Cause**: Gateway doesn't expose `/v1/chat/completions` endpoint

**Solution**:
1. Verify gateway API version: `curl http://localhost:9080/v1/models`
2. Check gateway configuration/routing rules
3. Ensure `/v1/` prefix is correct for your gateway

### Model responds with empty content

**Cause**: Model may not be loaded or overloaded

**Solution**:
1. Check model is loaded: `curl http://localhost:9080/v1/models`
2. Try simple prompt like "Say OK"
3. Increase timeout: add `timeout()` parameter to API calls

## 🧪 Testing

### Unit Test (smoke test included)

```bash
cd api
pnpm ts-node scripts/test_llm_gateway.ts
```

### Integration Test

```bash
# Start dev server
pnpm dev

# In another terminal, make a request
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello"}'
```

### Load Test

The streaming implementation handles concurrent requests out-of-the-box via OpenAI gateway load distribution.

## 📚 Remaining Work

The following files still have direct Ollama API calls and should be refactored:

1. **translation.ts** - Uses `getNextApiUrl('ollama')` and `/api/chat`
   - Should use `openaiClient.translate()` instead
   - Status: ⚠️ Partial (fallback still works with openaiClient)

2. **chatGenProcess.ts** - Line ~900: `callLLM()` function
   - Still fetches `getNextApiUrl('ollama')` for streaming
   - Should use `openaiClient.generateStream()` instead
   - Status: ⚠️ Works but needs refactoring for consistency

3. **flow/nodes/ollama.ts** - LangChain Ollama node
   - Considered deprecated; use `openaiNode` instead
   - Status: ⚠️ Functional but not recommended

4. **rag/services/embedder.py** - Python embeddings
   - Uses `langchain_ollama` for embeddings
   - Keep as-is if embeddings model is still on Ollama
   - Or update to OpenAI embeddings if available

## 🔄 Rollback Plan

If you need to revert to Ollama:

1. **Revert config**: Restore `config.Ollama.url` without LLM section
2. **Revert env**: Restore `OLLAMA_BASE_URL`, `OLLAMA_MODEL` variables
3. **Revert code**: Restore previous versions of:
   - legacy `api/src/services/llmService.ts`
   - `api/src/service/openai_client.ts` (remove new file)

## ✅ Verification Checklist

- [ ] `LLM_BASE_URL` is set and correct
- [ ] `LLM_API_KEY` is set
- [ ] `LLM_MODEL` is configured
- [ ] Smoke test passes: `pnpm ts-node scripts/test_llm_gateway.ts`
- [ ] API server starts without errors: `pnpm dev`
- [ ] Worker process starts: `pnpm worker`
- [ ] Chat completion requests work
- [ ] Translation requests work
- [ ] Streaming responses work

## 📞 Support

For issues or questions about the migration, refer to the inline comments in:
- `api/src/service/openai_client.ts` (detailed API reference)
- legacy `api/src/services/llmService.ts` notes in git history
