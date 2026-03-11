from config.index import config
from core.logging import logger
from models.schemas import DeleteRequest, DeleteResponseModel
from repositories.chroma_repository import chroma_db


def delete_collection(req: DeleteRequest) -> DeleteResponseModel:

    if config.RAG.mode[0] == "splitByArticleWithHybridSearch":
        collection_name = config.RAG.PreProcess.PDF.splitByArticle.collectionName
        if not req.ids:
            try:
                existing_names = {col.name for col in chroma_db.list_collections()}
                if collection_name in existing_names:
                    chroma_db.delete_collection(name=collection_name)
                # Re-create empty collection so search/upload code paths stay stable.
                chroma_db.get_or_create_collection(name=collection_name)
                logger.info(f"Cleared all documents from collection: {collection_name}")
                return DeleteResponseModel(
                    status="deleted",
                    collection=collection_name,
                )
            except Exception as e:
                logger.error(
                    f"Error clearing collection {collection_name} - {str(e)}"
                )
                return DeleteResponseModel(
                    status="failed",
                    collection=collection_name,
                )
        try:
            collection = chroma_db.get_collection(
                name=collection_name
            )

            if config.APP_MODE == "development":
                res_1 = collection.get(where={"file_id": {"$in": req.ids}})  # type: ignore
                logger.debug(f"Found {len(res_1['ids'])} records before deletion")

            collection.delete(
                where={"file_id": {"$in": req.ids}},  # type: ignore
            )

            if config.APP_MODE == "development":
                res_2 = collection.get(where={"file_id": {"$in": req.ids}})  # type: ignore
                logger.debug(f"Found {len(res_2['ids'])} records after deletion")

            logger.info(
                f"Deleted documents with IDs {req.ids} from collection: "
                f"{collection_name}"
            )
            return DeleteResponseModel(
                status="deleted",
                collection=collection_name,
                deleted_records=req.ids,
            )
        except Exception as e:
            logger.error(
                f"Error deleting documents with IDs {req.ids} from collection: "
                f"{collection_name} - {str(e)}"
            )
            return DeleteResponseModel(
                status="failed",
                collection=collection_name,
            )

    target = []
    for col in chroma_db.list_collections():
        meta = getattr(col, "metadata", None) or {}
        if meta.get("name") == req.collection_name:
            target.append(col.name)
    if not target:
        return DeleteResponseModel(status="no match", collection=req.collection_name)

    for name in target:
        chroma_db.delete_collection(name=name)
    return DeleteResponseModel(status="deleted", collection=req.collection_name)
