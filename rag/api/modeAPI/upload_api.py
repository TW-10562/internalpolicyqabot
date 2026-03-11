import uuid

import numpy as np
from chromadb.base_types import Metadata
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from repositories.chroma_repository import chroma_db
from services.embedder import embed_text, process_text
from utils.text_extraction import extract_text_from_file
from utils.text_splitter import split_text_with_overlap

router = APIRouter()


@router.post("/upload")
async def upload_file(collection_name: str = Form(...), file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="ファイル名が提供されていません。")

    try:
        content = await file.read()
        text = extract_text_from_file(file.filename, content)

        if not text:
            raise HTTPException(
                status_code=400, detail="テキストが抽出できませんでした。"
            )

        chunks = split_text_with_overlap(text)
        chunks = [chunk for chunk in chunks if chunk is not None and chunk.strip()]
        clean_chunks = [process_text(chunk) for chunk in chunks]
        embeddings = [embed_text(chunk) for chunk in chunks]
        embeddings = np.array(embeddings, dtype=np.float32)
        documents = clean_chunks
        metadatas: list[Metadata] = [{"source": file.filename} for _ in documents]
        ids = [str(uuid.uuid4()) for _ in documents]
        collection = chroma_db.get_or_create_collection(name=collection_name)

        collection.add(
            documents=documents, metadatas=metadatas, ids=ids, embeddings=embeddings
        )

        return {"status": "uploaded", "count": len(documents)}

    except Exception as e:
        print(e)
        raise HTTPException(status_code=500, detail=str(e))
