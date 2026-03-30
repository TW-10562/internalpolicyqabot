from models.schemas import DeleteRequest, UpdateRequest
from repositories.chroma_repository import chroma_db
from services.embedder import embed_text, process_text


def delete_document(req: DeleteRequest):
    collection = chroma_db.get_collection(name=req.collection_name)
    collection.delete(ids=req.ids)
    return {"status": "record deleted", "ids": req.ids}

def update_document(req: UpdateRequest):
    collection = chroma_db.get_collection(name=req.collection_name)

    clean_documents = [process_text(doc) for doc in req.documents]
    embeddings = [embed_text(doc) for doc in clean_documents]

    collection.delete(ids=req.ids)

    collection.add(
        ids=req.ids,
        documents=clean_documents,
        embeddings=embeddings,
        metadatas=req.metadatas,
    )

    return {
        "status": "updated",
        "collection": req.collection_name,
        "ids": req.ids
    }
