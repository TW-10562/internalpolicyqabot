#!/bin/bash
# Quick Start - LLM Migration

echo "========================================"
echo "  LLM Gateway Migration - Quick Start"
echo "========================================"
echo ""

# Step 1: Check prerequisites
echo "Step 1: Checking prerequisites..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 18+"
    exit 1
fi
if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm not found. Running: npm install -g pnpm"
    npm install -g pnpm
fi
echo "✅ Prerequisites OK"
echo ""

# Step 2: Update .env
echo "Step 2: Checking LLM configuration..."
if [ ! -f "./api/.env" ]; then
    echo "❌ api/.env not found. Copy from api/.env.example first:"
    echo "   cp api/.env.example api/.env"
    exit 1
fi

if ! grep -q "LLM_BASE_URL" ./api/.env; then
    echo "⚠️  LLM_BASE_URL not set in api/.env"
    echo "   Add: LLM_BASE_URL=http://localhost:9080/v1"
fi

if ! grep -q "LLM_MODEL" ./api/.env; then
    echo "⚠️  LLM_MODEL not set in api/.env"
    echo "   Add: LLM_MODEL=gptoss20b"
fi

echo "✅ Configuration check done"
echo ""

# Step 3: Verify gateway
echo "Step 3: Checking LLM gateway..."
GATEWAY_URL=$(grep "LLM_BASE_URL=" ./api/.env | cut -d'=' -f2)
GATEWAY_URL=${GATEWAY_URL#"http://"}
GATEWAY_URL=${GATEWAY_URL%"/v1"}

if curl -s http://$GATEWAY_URL/v1/models > /dev/null 2>&1; then
    echo "✅ Gateway is reachable at http://$GATEWAY_URL"
else
    echo "⚠️  Cannot reach gateway at http://$GATEWAY_URL"
    echo "   Is it running? Check: curl http://$GATEWAY_URL/v1/models"
fi
echo ""

# Step 4: Run smoke test
echo "Step 4: Running smoke test..."
cd api
if pnpm exec ts-node scripts/test_llm_gateway.ts ; then
    echo "✅ Smoke test PASSED"
else
    echo "❌ Smoke test FAILED. Check gateway and API key."
    exit 1
fi
echo ""

# Step 5: Start services
echo "Step 5: Starting services..."
echo ""
echo "Starting API server in background..."
pnpm dev > /tmp/api.log 2>&1 &
API_PID=$!

echo "Starting worker in background..."
pnpm worker > /tmp/worker.log 2>&1 &
WORKER_PID=$!

echo ""
echo "========================================"
echo "  Services Started!"
echo "========================================"
echo ""
echo "API Server PID: $API_PID"
echo "  Logs: tail -f /tmp/api.log"
echo "  URL: http://localhost:8080"
echo ""
echo "Worker PID: $WORKER_PID"
echo "  Logs: tail -f /tmp/worker.log"
echo ""
echo "To stop services:"
echo "  kill $API_PID $WORKER_PID"
echo ""
echo "========================================"
