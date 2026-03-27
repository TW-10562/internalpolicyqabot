#!/usr/bin/env python3
"""Bulk-load documents from a directory into ChromaDB with GPU embeddings.

Processes PDFs via the article-splitting pipeline and other files via
page-chunk splitting, then embeds everything with the configured model.

Usage:
    python3 rag/scripts/bulk_load.py --docs-dir /home/qabot/TEST_DOCS
"""
from __future__ import annotations

import argparse
import os
import sys
import uuid
from pathlib import Path
from time import perf_counter

# Ensure rag/ is on sys.path so we can import project modules
RAG_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAG_ROOT))

import numpy as np
from chromadb import PersistentClient
from core.logging import logger
from config.index import config
from services.embedder import embed_text_batch, EMBEDDING_MODEL_DEVICE

# Article-based PDF parser
from api.modeAPI.splitByArticle_api import parse_document_by_content
from models.schemas import ArticleBasedSplitRecordMetadataModel

# Generic text extraction + chunking
from utils.text_extraction import extract_text_from_file
from utils.text_splitter import split_text_with_overlap
from services.embedder import process_text


SUPPORTED_EXT = {".pdf", ".docx", ".doc", ".txt", ".md", ".csv"}


def find_documents(docs_dir: Path) -> list[Path]:
    """Recursively find all supported documents."""
    files = []
    for f in sorted(docs_dir.rglob("*")):
        if f.is_file() and f.suffix.lower() in SUPPORTED_EXT:
            files.append(f)
    return files


def process_pdf_article(file_path: Path) -> tuple[list[str], list[dict]]:
    """Parse a PDF using article-based splitting. Returns (documents, metadatas)."""
    content = file_path.read_bytes()
    doc_name = file_path.stem

    articles = parse_document_by_content(content, doc_name)
    if not articles:
        return [], []

    documents = []
    metadatas = []
    for article in articles:
        text_content = article.get("TextContent", "")
        if not text_content or not text_content.strip():
            continue
        article_copy = article.copy()
        article_copy.pop("TextContent", None)
        try:
            meta_model = ArticleBasedSplitRecordMetadataModel(**article_copy)
            documents.append(f"{meta_model.build_hierarchy_label()}\n\n{text_content}")
            metadatas.append(meta_model.to_dict())
        except Exception:
            # Fallback: use raw metadata
            documents.append(text_content)
            metadatas.append({"DocumentName": doc_name})

    return documents, metadatas


def process_generic_file(file_path: Path) -> tuple[list[str], list[dict]]:
    """Extract text and chunk a non-PDF (or fallback for PDFs)."""
    content = file_path.read_bytes()
    filename = file_path.name

    text = extract_text_from_file(filename, content)
    if not text:
        return [], []

    chunks = split_text_with_overlap(text)
    chunks = [c for c in chunks if c and c.strip()]
    clean_chunks = [process_text(c) for c in chunks]

    documents = clean_chunks
    metadatas = [{"source": filename, "DocumentName": file_path.stem}] * len(documents)
    return documents, metadatas


def main():
    parser = argparse.ArgumentParser(description="Bulk load documents into ChromaDB")
    parser.add_argument("--docs-dir", required=True, help="Directory with documents to load")
    parser.add_argument(
        "--collection",
        default=config.RAG.PreProcess.PDF.splitByArticle.collectionName,
        help="ChromaDB collection name",
    )
    parser.add_argument("--batch-size", type=int, default=4, help="Embedding batch size")
    parser.add_argument("--db-path", default=config.RAG.VectorStore.path, help="ChromaDB path")
    args = parser.parse_args()

    docs_dir = Path(args.docs_dir).resolve()
    if not docs_dir.exists():
        print(f"Error: {docs_dir} does not exist")
        return 1

    files = find_documents(docs_dir)
    print(f"Found {len(files)} documents in {docs_dir}")
    print(f"Embedding device: {EMBEDDING_MODEL_DEVICE}")
    print(f"Collection: {args.collection}")
    print(f"DB path: {args.db_path}")

    # Collect all documents
    all_documents: list[str] = []
    all_metadatas: list[dict] = []
    skipped = 0

    for i, file_path in enumerate(files):
        ext = file_path.suffix.lower()
        rel = file_path.relative_to(docs_dir)
        try:
            if ext == ".pdf":
                docs, metas = process_pdf_article(file_path)
                if not docs:
                    # Fallback to generic chunking
                    docs, metas = process_generic_file(file_path)
            elif ext == ".doc":
                # .doc files not supported by python-docx, skip
                print(f"  [{i+1}/{len(files)}] SKIP (old .doc format): {rel}")
                skipped += 1
                continue
            else:
                docs, metas = process_generic_file(file_path)

            if docs:
                all_documents.extend(docs)
                all_metadatas.extend(metas)
                print(f"  [{i+1}/{len(files)}] {rel} -> {len(docs)} chunks")
            else:
                print(f"  [{i+1}/{len(files)}] SKIP (no text): {rel}")
                skipped += 1
        except Exception as e:
            print(f"  [{i+1}/{len(files)}] ERROR {rel}: {e}")
            skipped += 1

    print(f"\nTotal chunks: {len(all_documents)} from {len(files)-skipped} files ({skipped} skipped)")

    if not all_documents:
        print("Nothing to embed.")
        return 0

    # Embed all documents
    print(f"\nEmbedding {len(all_documents)} chunks (batch_size={args.batch_size})...")
    t0 = perf_counter()
    embeddings = embed_text_batch(all_documents, batch_size=args.batch_size)
    elapsed = perf_counter() - t0
    print(f"Embedding done in {elapsed:.1f}s ({len(all_documents)/elapsed:.1f} chunks/s)")

    # Store in ChromaDB
    print(f"\nWriting to ChromaDB collection '{args.collection}'...")
    client = PersistentClient(path=args.db_path)
    collection = client.get_or_create_collection(
        name=args.collection,
        metadata={
            "embedding_model": config.Models.ragEmbeddingModel.name,
            "embedding_dimension": len(embeddings[0]),
        },
    )

    ids = [str(uuid.uuid4()) for _ in all_documents]
    emb_array = np.array(embeddings, dtype=np.float32)

    # Write in batches to avoid memory issues
    write_batch = 100
    for start in range(0, len(ids), write_batch):
        end = min(len(ids), start + write_batch)
        collection.add(
            ids=ids[start:end],
            documents=all_documents[start:end],
            metadatas=all_metadatas[start:end],
            embeddings=emb_array[start:end],
        )
        print(f"  Written {end}/{len(ids)} records")

    print(f"\nDone! Collection '{args.collection}' now has {collection.count()} documents.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
