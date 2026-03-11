from models.schemas import DeleteRequest, UpdateRequest
from repositories.chroma_repository import chroma_db
from services.embedder import embed_text, process_text


def delete_document(req: DeleteRequest):
    collection = chroma_db.get_collection(name=req.collection_name)
    collection.delete(ids=req.ids)
    return {"status": "record deleted", "ids": req.ids}

def update_document(req: UpdateRequest):
    collection = chroma_db.get_collection(name=req.collection_name)
    clean_text = process_text(req.new_text)
    embedding = embed_text(clean_text)

    collection.delete(ids=[req.id])

    collection.add(
        ids=[req.id],
        documents=[clean_text],
        embeddings=[embedding]
    )

    return {
        "status": "updated",
        "collection": req.collection_name,
        "id": req.id
    }
