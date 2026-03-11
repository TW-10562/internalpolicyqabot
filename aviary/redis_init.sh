#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [ -f "$ENV_FILE" ]; then
    export $(grep -v '^#' "$ENV_FILE" | grep -v '^[[:space:]]*$' | xargs)
else
    echo "Warning: .env file not found at $ENV_FILE"
fi

# ================= 配置区域 =================
REDIS_HOST=${REDIS_HOST:-localhost}
REDIS_PORT=${REDIS_PORT:-6379}
REDIS_PASSWORD=${REDIS_PASSWORD:-abcd1234}
REDIS_DB=${REDIS_DB:-0}
# ===========================================

run_redis() {
    # 检查 redis-cli 是否可用
    if command -v redis-cli >/dev/null 2>&1; then
        # 使用本地 redis-cli
        redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" -n "$REDIS_DB" --no-auth-warning "$@"
    elif docker ps --format '{{.Names}}' | grep -q '^aviary-redis$'; then
        # 尝试使用 docker 容器 (aviary-redis)
        docker exec -i aviary-redis redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" -n "$REDIS_DB" --no-auth-warning "$@"
    elif docker ps --format '{{.Names}}' | grep -q '^redis$'; then
        # 尝试使用 docker 容器 (redis)
        docker exec -i redis redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" -n "$REDIS_DB" --no-auth-warning "$@"
    else
        echo "Error: redis-cli not found and no redis container running"
        exit 1
    fi
}

# ==============================================================================
# 核心函数: 模拟后端逻辑
# 参数 1: Type (e.g., openai, tts) -> 对应代码中的 category/prefix
# 参数 2: Name (e.g., gpt-4)       -> 对应代码中的 modelName
# 参数 3: URL
# 参数 4: Score (可选，默认 0)
# ==============================================================================
add_model() {
    local TYPE=$1
    local NAME=$2
    local URL=$3
    local SCORE=${4:-0} # 如果没传分数，默认为 0

    local KEY="${TYPE}:${NAME}"

    run_redis ZADD "$KEY" "$SCORE" "$URL"
}

echo "Starting Redis Initialization..."
echo "-------------------------------------------------------"

# ================Openai Endpoints==========================
# qwen3:8b
add_model "openai" "qwen3-8b" "http://gx10-a660.local:2077" 0
# qwen2.5-coder
add_model "openai" "Qwen/Qwen2.5-Coder-32B-Instruct" "http://gx10-a660.local:2077" 0
add_model "openai" "qwen2.5-coder-latest" "http://n8360-desktop.local:1983" 3
# qwen3:30b-a3b
add_model "openai" "qwen3-30b-a3b" "http://gx10-a660.local:2077" 0
add_model "openai" "qwen3-30b-a3b" "http://n8360-desktop.local:1984" 3
# gpt-oss-20b
add_model "openai" "gpt-oss-20b" "http://gx10-a660.local:2025" 0
add_model "openai" "gpt-oss-20b" "http://n8360-desktop.local:1985" 3
# gpt-oss-120b
add_model "openai" "gpt-oss-120b" "http://n8360-desktop.local:1989" 0

# =================Embedding Endpoints=========================
add_model "embedding" "BAAI/bge-m3" "http://n8360-desktop.local:1986/embeddings" 0

echo "-------------------------------------------------------"
echo "Initialization Complete."
if command -v redis-cli >/dev/null 2>&1; then
    echo "Verify with: redis-cli -h $REDIS_HOST -p $REDIS_PORT -a '$REDIS_PASSWORD' -n $REDIS_DB KEYS '*'"
elif docker ps --format '{{.Names}}' | grep -q '^aviary-redis$'; then
    echo "Verify with: docker exec -i aviary-redis redis-cli -h $REDIS_HOST -p $REDIS_PORT -a '$REDIS_PASSWORD' -n $REDIS_DB KEYS '*'"
else
    echo "Verify with: docker exec -i redis redis-cli -h $REDIS_HOST -p $REDIS_PORT -a '$REDIS_PASSWORD' -n $REDIS_DB KEYS '*'"
fi
