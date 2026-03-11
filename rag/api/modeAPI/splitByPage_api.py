import json
import uuid
from time import time
from typing import Literal

import numpy as np
from chromadb.base_types import Metadata
from config.index import config
from fastapi import APIRouter, Form, HTTPException
from pydantic import BaseModel
from repositories.chroma_repository import chroma_db
from services.embedder import embed_text
from utils.solr import get_solr_doc_by_id
from utils.text_splitter import split_text

router = APIRouter()


class UploadFileResult(BaseModel):
    status: Literal["uploaded", "failed"]
    count: int
    time_taken: int  # in ms


@router.post("/upload-pdf-pages/solr")
async def upload_pdf_pages_stored_in_solr(
    pages_id: str = Form(...),
    collection_name: str = Form(...),
):
    print("splitByPage_api called")
    timestart = time()
    pages_id = json.loads(pages_id)
    chunk_count = 0
    # TODO: improve the performance
    #       Parallelize or Batch Solr document fetching
    for cur_page_id in pages_id:
        page = get_solr_doc_by_id(
            solr_url=config.ApacheSolr.url,
            core=config.ApacheSolr.coreName,
            doc_id=cur_page_id,
        )
        try:
            text = page.content[0] if page.content else ""

            if not text:
                raise HTTPException(
                    status_code=400, detail="テキストが抽出できませんでした。"
                )

            chunks = split_text(
                text,
                separator=config.RAG.PreProcess.PDF.splitByPage.separator,  # type: ignore
                chunk_size=config.RAG.PreProcess.PDF.splitByPage.chunkSize,  # type: ignore
                overlap=config.RAG.PreProcess.PDF.splitByPage.overlap,  # type: ignore
            )
            documents = [
                chunk for chunk in chunks if chunk is not None and chunk.strip()
            ]
            embeddings = [embed_text(chunk) for chunk in chunks]
            relative_path = page.file_path_s if page.file_path_s else ""
            relative_path = relative_path[relative_path.find("uploads") :]
            metadatas: list[Metadata] = [
                {
                    "title": page.title[0] if page.title else "",
                    "chunk_number_i": (
                        page.chunk_number_i if page.chunk_number_i else -1
                    ),
                    "file_path_s": relative_path,
                }
                for _ in documents
            ]
            ids = [str(uuid.uuid4()) for _ in documents]
            metadata = {"name": collection_name}
            collection = chroma_db.get_or_create_collection(
                name=cur_page_id, metadata=metadata
            )
            embeddings = np.array(embeddings, dtype=np.float32)
            collection.add(
                documents=documents, metadatas=metadatas, ids=ids, embeddings=embeddings
            )
            chunk_count += len(chunks)

        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    return UploadFileResult(
        status="uploaded",
        count=chunk_count,
        time_taken=int((time() - timestart) * 1000),
    )
