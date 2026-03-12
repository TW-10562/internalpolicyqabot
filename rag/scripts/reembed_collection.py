#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from chromadb import PersistentClient
from langchain_huggingface import HuggingFaceEmbeddings


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[2]
    rag_root = project_root / "rag"
    default_db_path = rag_root / "app" / "rag_db"
    default_model = "BAAI/bge-m3"
    default_model_dir = rag_root / "data" / "model" / default_model.replace("/", "_")

    parser = argparse.ArgumentParser(
        description="Rebuild a Chroma collection with fresh embeddings from persisted documents.",
    )
    parser.add_argument(
        "--db-path",
        default=str(default_db_path),
        help="Path to the source Chroma persistence directory.",
    )
    parser.add_argument(
        "--output-db-path",
        default="",
        help="Optional path to a fresh target Chroma persistence directory.",
    )
    parser.add_argument(
        "--collection",
        default="splitByArticleWithHybridSearch",
        help="Chroma collection name to rebuild.",
    )
    parser.add_argument(
        "--model",
        default=default_model,
        help="Embedding model name for audit metadata.",
    )
    parser.add_argument(
        "--model-dir",
        default=str(default_model_dir),
        help="Local path to the embedding model directory.",
    )
    parser.add_argument(
        "--device",
        default="cpu",
        help="Embedding device passed to HuggingFaceEmbeddings.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=16,
        help="Embedding batch size.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=5,
        help="Validation top-k.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Inspect the collection and validation queries without mutating the store.",
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="Skip post-rebuild validation queries.",
    )
    parser.add_argument(
        "--validate-query",
        action="append",
        dest="validate_queries",
        default=[],
        help="Validation query to run after rebuild. Repeatable.",
    )
    return parser.parse_args()


def load_collection_dimension(db_path: Path, collection_name: str) -> int | None:
    db_file = db_path / "chroma.sqlite3"
    if not db_file.exists():
        return None
    with sqlite3.connect(db_file) as conn:
        row = conn.execute(
            "select dimension from collections where name = ?",
            (collection_name,),
        ).fetchone()
    if not row:
        return None
    value = row[0]
    return int(value) if value is not None else None


def build_embedder(model_dir: Path, device: str) -> HuggingFaceEmbeddings:
    return HuggingFaceEmbeddings(
        model_name=str(model_dir),
        model_kwargs={
            "device": device,
            "local_files_only": True,
        },
        encode_kwargs={"normalize_embeddings": True},
    )


def embed_documents(
    embedder: HuggingFaceEmbeddings,
    documents: list[str],
    batch_size: int,
) -> list[list[float]]:
    out: list[list[float]] = []
    for start in range(0, len(documents), batch_size):
        batch = documents[start : start + batch_size]
        out.extend(embedder.embed_documents(batch))
        print(
            f"[reembed] embedded {min(len(documents), start + len(batch))}/{len(documents)} documents",
            flush=True,
        )
    return out


def add_documents_in_batches(
    collection: Any,
    ids: list[str],
    documents: list[str],
    metadatas: list[dict[str, Any] | None],
    embeddings: list[list[float]],
    batch_size: int,
) -> None:
    for start in range(0, len(ids), batch_size):
        end = min(len(ids), start + batch_size)
        collection.add(
            ids=ids[start:end],
            documents=documents[start:end],
            metadatas=metadatas[start:end],
            embeddings=np.array(embeddings[start:end], dtype=np.float32),
        )
        print(f"[reembed] wrote {end}/{len(ids)} records", flush=True)


def normalize_metadata_rows(rows: list[Any]) -> list[dict[str, Any] | None]:
    normalized: list[dict[str, Any] | None] = []
    for row in rows:
        if isinstance(row, dict):
            normalized.append(row)
        else:
            normalized.append(None)
    return normalized


def run_validation(
    collection: Any,
    embedder: HuggingFaceEmbeddings,
    queries: list[str],
    top_k: int,
) -> None:
    if not queries:
        return

    for query in queries:
        query_embedding = embedder.embed_query(query)
        try:
            result = collection.query(
                query_embeddings=[query_embedding],
                n_results=top_k,
                include=["documents", "metadatas", "distances"],
            )
        except Exception as exc:
            print(
                f"[validate] query={json.dumps(query, ensure_ascii=False)} failed: {exc}",
                flush=True,
            )
            continue
        print(f"[validate] query={json.dumps(query, ensure_ascii=False)}")
        docs = result.get("documents", [[]])[0]
        metas = result.get("metadatas", [[]])[0]
        distances = result.get("distances", [[]])[0]
        for idx, (doc, meta, distance) in enumerate(zip(docs, metas, distances), start=1):
            metadata = meta or {}
            title = metadata.get("DocumentName") or metadata.get("file_name_s") or metadata.get("title") or "unknown"
            snippet = str(doc or "").replace("\n", " ")[:160]
            print(
                f"  {idx}. distance={distance:.6f} title={title} snippet={snippet}",
                flush=True,
            )


def main() -> int:
    args = parse_args()
    db_path = Path(args.db_path).resolve()
    output_db_path = Path(args.output_db_path).resolve() if args.output_db_path else db_path
    model_dir = Path(args.model_dir).resolve()
    if not db_path.exists():
        print(f"[reembed] db path not found: {db_path}", file=sys.stderr)
        return 2
    if not model_dir.exists():
        print(f"[reembed] model dir not found: {model_dir}", file=sys.stderr)
        return 2

    source_client = PersistentClient(path=str(db_path))
    collection = source_client.get_collection(args.collection)
    original_metadata = dict(getattr(collection, "metadata", {}) or {})
    existing_dimension = load_collection_dimension(db_path, args.collection)
    payload = collection.get(include=["documents", "metadatas"])
    ids = [str(value) for value in payload.get("ids", [])]
    documents = [str(value or "") for value in payload.get("documents", [])]
    metadatas = normalize_metadata_rows(payload.get("metadatas", []))

    if not ids or not documents:
        print(f"[reembed] collection '{args.collection}' is empty; nothing to rebuild.")
        return 0

    print(
        f"[reembed] collection={args.collection} count={len(ids)} existing_dimension={existing_dimension}",
        flush=True,
    )
    print(
        f"[reembed] model={args.model} model_dir={model_dir} device={args.device} output_db_path={output_db_path}",
        flush=True,
    )

    embedder = build_embedder(model_dir, args.device)
    sample_vector = embedder.embed_query("dimension probe")
    target_dimension = len(sample_vector)
    print(f"[reembed] target_dimension={target_dimension}", flush=True)

    validation_queries = args.validate_queries or [
        "What is the reporting process for workplace disciplinary incidents?",
        "残業の申請方法",
    ]

    if args.dry_run:
        print("[reembed] dry-run enabled; no collection changes will be made.", flush=True)
        if not args.skip_validation:
            run_validation(collection, embedder, validation_queries, args.top_k)
        return 0

    rebuilt_at = datetime.now(timezone.utc).isoformat()
    rebuild_metadata = {
        **original_metadata,
        "embedding_model": args.model,
        "embedding_dimension": target_dimension,
        "rebuild_source": "persisted_chroma_documents",
        "rebuilt_at": rebuilt_at,
    }

    embeddings = embed_documents(embedder, documents, args.batch_size)

    if output_db_path == db_path:
        source_client.delete_collection(args.collection)
        target_client = source_client
    else:
        output_db_path.mkdir(parents=True, exist_ok=True)
        target_client = PersistentClient(path=str(output_db_path))

    rebuilt = target_client.get_or_create_collection(name=args.collection, metadata=rebuild_metadata)
    add_documents_in_batches(
        collection=rebuilt,
        ids=ids,
        documents=documents,
        metadatas=metadatas,
        embeddings=embeddings,
        batch_size=args.batch_size,
    )

    final_dimension = load_collection_dimension(output_db_path, args.collection)
    print(
        f"[reembed] rebuild complete collection={args.collection} count={rebuilt.count()} "
        f"final_dimension={final_dimension}",
        flush=True,
    )

    if not args.skip_validation:
        run_validation(rebuilt, embedder, validation_queries, args.top_k)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
