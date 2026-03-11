#!/bin/bash
# Aviary Lite プロジェクト初期化スクリプト
# 新しいメンバーがプロジェクト関連の依存関係をワンクリックでインストールし、関連設定を行うためのスクリプト
set -euo pipefail

echo "=================================="
echo "Aviary Lite プロジェクトの初期化を開始します..."
echo "=================================="

# 1.mysql redis solrのdocker container作成
echo "1. docker container(mysql, redis, solr)の作成"
if [ -f "docker-compose.yml" ]; then
    docker compose up -d
    echo "✓ Middleware containers started."
else
    echo "✗ docker-compose.yml not found. Please start MySQL, Redis and Solr manually."
fi

EXPECTED_CONTAINERS=3
MAX_RETRY=30

echo "solrコンテナが起動するまで待機..."

for i in $(seq 1 $MAX_RETRY); do
  RUNNING=$(docker compose ps --status running --services | wc -l)

  if curl -s http://localhost:8983/solr/admin/cores > /dev/null; then
    docker compose ps
    echo "✅ solrコンテナが起動しました"
    break
  fi

  echo "⏳ 待機中(${i}s 経過)"
  sleep 1
done

# まだ揃っていない場合はエラー終了
RUNNING=$(docker compose ps --status running --services | wc -l)
if [ "$RUNNING" -lt "$EXPECTED_CONTAINERS" ]; then
  echo "❌ タイムアウト: ${EXPECTED_CONTAINERS} 個のコンテナが揃いませんでした"
  docker compose ps
  exit 1
fi
echo ""

# 2. Solr Schema API の設定 - page_number_i フィールドを追加
echo "2. Solr Schema を設定中..."
echo "page_number_i フィールドを Solr に追加中..."

# Solr の起動を待つ（必要な場合）
echo "Solr が実行されているかチェック中..."
if ! curl -s http://localhost:8983/solr/admin/cores > /dev/null; then
    echo "警告: Solr が localhost:8983 で動作していないようです"
    echo "Solr が起動していることを確認してから、このスクリプトを再実行してください"
    echo "または Solr 設定をスキップして依存関係のインストールを続行してください..."
    read -p "Solr 設定をスキップして続行しますか? (y/n): " skip_solr
    if [[ $skip_solr != "y" && $skip_solr != "Y" ]]; then
        exit 1
    fi
else
    # page_number_i フィールドを追加
    curl_response=$(curl -s -w "%{http_code}" -X POST http://localhost:8983/solr/mycore/schema \
      -H 'Content-type:application/json' \
      --data-binary '{
        "add-field":{
          "name":"page_number_i",
          "type":"pint",
          "stored":true,
          "indexed":true,
          "docValues":true
        }
      }')
    
    http_code=$(echo "$curl_response" | tail -c 4)
    
    if [[ $http_code == "200" ]]; then
        echo "✓ Solr フィールド page_number_i が正常に追加されました"
    else
        echo "⚠ Solr フィールドの追加が失敗した可能性があります。HTTP ステータスコード: $http_code"
        echo "これはフィールドが既に存在するか、その他の理由による可能性があります。インストールを続行します..."
    fi

    # file_path フィールドを追加
    curl_response=$(curl -s -w "%{http_code}" -X POST http://localhost:8983/solr/mycore/schema \
      -H 'Content-type:application/json' \
      --data-binary '{
        "add-field":{
          "name":"file_path",
          "type":"string",
          "stored":true,
          "indexed":true,
          "docValues":true
        }
      }')

    http_code=$(echo "$curl_response" | tail -c 4)

    if [[ $http_code == "200" ]]; then
        echo "✓ Solr フィールド file_path が正常に追加されました"
    else
        echo "⚠ Solr フィールドの追加が失敗した可能性があります。HTTP ステータスコード: $http_code"
        echo "これはフィールドが既に存在するか、その他の理由による可能性があります。インストールを続行します..."
    fi
fi

echo ""

# 3. API 依存関係をインストール
echo "3. API 依存関係をインストール中..."
echo "./api ディレクトリに移動して依存関係をインストール中..."

if [ -d "./api" ]; then
    cd ./api
    echo "現在のディレクトリ: $(pwd)"
    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
            echo "✓ .env file created from .env.example."
        else
            echo "✗ .env.example not found. Please create .env manually."
        fi
    fi
    if [ -f "package.json" ]; then
        echo "pnpm install を実行中..."
        pnpm install
        echo "✓ API 依存関係のインストールが成功しました"
    else
        echo "✗ package.json ファイルが見つかりません"
        exit 1
    fi

    cd ..
else
    echo "✗ ./api ディレクトリが見つかりません"
    exit 1
fi

echo ""

# 4. UI 依存関係をインストール
echo "4. UI 依存関係をインストール中..."
echo "./ui-2 ディレクトリに移動して依存関係をインストール中..."

if [ -d "./ui-2" ]; then
    cd ./ui-2
    echo "現在のディレクトリ: $(pwd)"
    
    if [ -f "package.json" ]; then
        echo "pnpm install を実行中..."
        pnpm install
        echo "✓ UI 依存関係のインストールが成功しました"
    else
        echo "✗ package.json ファイルが見つかりません"
        exit 1
    fi
    
    cd ..
else
    echo "✗ ./ui-2 ディレクトリが見つかりません"
    exit 1
fi

echo ""

# 4. RAG 依存関係をインストール
echo "4. RAG 依存関係をインストール中..."
echo "./rag ディレクトリに移動して依存関係をインストール中..."

if [ -d "./rag" ]; then
    cd ./rag
    echo "現在のディレクトリ: $(pwd)"

    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
            echo "✓ .env file created from .env.example."
        else
            echo "✗ .env.example not found. Please create .env manually."
        fi
    fi

    VENV_DIR=".venv"
    # ===== venv 準備 =====
    if [ ! -d "$VENV_DIR" ]; then
        python3 -m venv "$VENV_DIR"
    fi
    PY="$VENV_DIR/bin/python"

    # PyTorch がインポートできるかどうか確認
    if "$PY" -c 'import torch' >/dev/null 2>&1; then
        echo "✅ PyTorch が既にインストールされています。インストール処理をスキップします。"
    else
        echo "⚠️ PyTorch が見つかりません。インストールします。"
        if command -v nvidia-smi >/dev/null 2>&1; then
            echo "GPU 検出: CUDA 版をインストールします"
            "$PY" -m pip install torch --index-url https://download.pytorch.org/whl/cu126
        else
            echo "GPU なし: CPU 版をインストールします"
            "$PY" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
        fi
    fi

    if [ -f "requirements.txt" ]; then
        echo "pip install -r requirements.txt を実行中..."
        "$PY" -m  pip install -r requirements.txt
        echo "✓ RAG 依存関係のインストールが成功しました"
    else
        echo "✗ requirements.txt ファイルが見つかりません"
        exit 1
    fi
    
    cd ..
else
    echo "✗ ./rag ディレクトリが見つかりません"
    exit 1
fi

echo ""
echo "=================================="
echo "Aviary Lite プロジェクトの初期化が完了しました"
echo ""
echo "インストール完了したコンポーネント:"
echo "✓ Solr Schema 設定"
echo "✓ API 依存関係 (Node.js/TypeScript)"
echo "✓ UI 依存関係 (React/Vite)"
echo "✓ RAG 依存関係 (Python/FastAPI)"
echo ""
echo "次に以下を実行できます:"
echo "1. API サービスを開始: cd api && pnpm run dev"
echo "2. UI サービスを開始: cd ui-2 && pnpm run dev"
echo "3. RAG サービスを開始: cd rag && python main.py"
echo ""
echo "関連サービス（データベース、Redis、Solr など）が正しく設定・起動されていることを確認してください。"
