#!/usr/bin/env python3
"""
FAQ Debug services - Export and Clean
"""

from fastapi import APIRouter, HTTPException, status
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.schema import ExportResponse, CleanAnswersResponse, FAQItem
from database.chroma_repository import ChromaRepository

router = APIRouter()

# Global variables
repo = None


def _sanitize_answer(text: str) -> str:
    """Conservative sanitizer to remove leading system prologues or translator
    prefixes (for example English/Japanese system prompts) from
    answers before they are used to rebuild the collection.
    """
    if not text:
        return text
    t = text.strip()
    markers = [
        'You are', 'あなたは', '以下は社内FAQシステムから取得した回答です', '## FAQ回答'
    ]

    head = t[:1000]
    for m in markers:
        if head.startswith(m):
            # find a reasonable split point
            for s in ['\n\n', '\n#', '\n##', '\n回答', '\n以下は', '\n\r\n']:
                idx = t.find(s)
                if idx > 0:
                    return t[idx + len(s):].strip()
            # fallback: try to find '以下は' or '回答:'
            for s in ['以下は', '回答:', 'Answer:']:
                idx = t.find(s)
                if idx > 0:
                    return t[idx + len(s):].strip()
            return t
    return t


def initialize_faq_system():
    """Initialize the FAQ system components."""
    global repo
    
    if repo is None:
        print("Initializing FAQ cache system...")
        import os
        db_path = "./database/chroma_db"
        
        if not os.path.exists(os.path.join(db_path, "chroma.sqlite3")):
            print("❌ FAQ database not found. Please run main.py first to build the database.")
            return False
        
        try:
            repo = ChromaRepository(db_path=db_path)
            collection = repo.get_collection("faq_collection")
            print(f"✅ FAQ cache system initialized with {collection.count()} items")
            return True
        except Exception as e:
            print(f"❌ Error initializing FAQ system: {e}")
            return False
    
    return True


@router.get("/debug/export", response_model=ExportResponse, tags=["Debug"])
async def debug_export_faqs():
    """
    Return a JSON dump of current FAQ documents and metadata for inspection.
    This endpoint is intended for local debugging in development only.
    """
    try:
        if not initialize_faq_system():
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="FAQ system not initialized"
            )

        collection = repo.get_collection('faq_collection')
        if not collection:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="faq_collection not found"
            )

        # Request without include to maximize compatibility across Chroma versions
        res = collection.get()

        # Truncate long answers for safety
        out = []
        ids = res.get('ids') or []
        docs = res.get('documents') or []
        metas = res.get('metadatas') or []
        count = max(len(ids), len(docs), len(metas))
        for i in range(count):
            _id = ids[i] if i < len(ids) else f"doc_{i}"
            meta = metas[i] if i < len(metas) else {}
            out.append(FAQItem(
                id=_id,
                question=meta.get('question') if meta else (docs[i] if i < len(docs) else None),
                answer_preview=(meta.get('answer')[:500] + '...') if meta and meta.get('answer') and len(meta.get('answer')) > 500 else (meta.get('answer') if meta else None)
            ))

        return ExportResponse(count=len(out), items=out)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[DEBUG EXPORT] Error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.post("/debug/clean_answers", response_model=CleanAnswersResponse, tags=["Debug"])
async def debug_clean_answers():
    """
    Sanitize stored answers and rebuild faq_collection with cleaned answers.
    This is a destructive operation; a backup of chroma.sqlite3 is created.
    """
    try:
        if not initialize_faq_system():
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="FAQ system not initialized"
            )

        import os
        db_path = './database/chroma_db'
        sqlite_path = os.path.join(db_path, 'chroma.sqlite3')
        if os.path.exists(sqlite_path):
            import shutil, time
            bak = f"{sqlite_path}.backup.{int(time.time())}"
            shutil.copy2(sqlite_path, bak)
            print(f"[DEBUG CLEAN] Backup created: {bak}")

        collection = repo.get_collection('faq_collection')
        if not collection:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="faq_collection not found"
            )

        # Request without include for compatibility; we'll handle available fields
        res = collection.get()

        docs = res.get('documents', []) or []
        metas = res.get('metadatas', []) or []

        questions = []
        answers = []

        for i, meta in enumerate(metas):
            if meta and isinstance(meta, dict):
                q = meta.get('question')
                a = meta.get('answer', '')
            else:
                q = docs[i] if i < len(docs) else None
                a = ''

            if not q:
                q = docs[i] if i < len(docs) else f"faq_{i}"

            clean_a = _sanitize_answer(a) if a else ''
            questions.append(q)
            answers.append(clean_a)

        # Build embeddings and recreate collection using repo.store_in_chromadb
        from src.hotchpotch import EmbeddingWrapper
        embedder = EmbeddingWrapper()
        embeddings = embedder.encode(questions)

        # normalize embeddings to a plain Python list of lists
        try:
            embeddings_list = embeddings.tolist()
        except Exception:
            embeddings_list = list(embeddings)

        repo.store_in_chromadb(questions, answers, embeddings_list, collection_name='faq_collection')

        return CleanAnswersResponse(
            success=True,
            message="Rebuilt faq_collection with sanitized answers",
            count=len(questions)
        )
    except HTTPException:
        raise
    except Exception as e:
        print(f"[DEBUG CLEAN] Error: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
