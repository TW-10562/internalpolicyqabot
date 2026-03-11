import re
from concurrent.futures import ThreadPoolExecutor, as_completed

from config.index import config
from core.logging import logger
from models.schemas import SearchRequest
from repositories.chroma_repository import chroma_db
from services.reranker_service import get_ranked_results
from utils.search import search_query


def search_process(collection_name, query):
    try:
        # Step 1: Query ChromaDB
        collection = chroma_db.get_collection(collection_name)
        raw_result = search_query(
            collection, query, top_k=config.RAG.Retrieval.topKForEachCollection
        )

        if not raw_result:
            return []

        if config.APP_MODE == "rag-evaluation":
            logger.info(f"[RAG] Raw search results: {raw_result}")

        return raw_result
    except Exception as _:
        if config.APP_MODE == "rag-evaluation":
            logger.error(
                f"[RAG] Error in search_process('{collection_name}'), skipping..."
            )
            return []


def search_rag(req: SearchRequest):
    try:
        logger.info(
            f"[RAG] Starting search_rag: {req.collection_name}, query='{req.query}', mode={req.mode}"
        )

        all_results = []

        expanded_collection_name_set = set()
        if config.RAG.Retrieval.usingNeighborChunkAware:
            for c in req.collection_name:
                if c.startswith(f"{req.mode}-"):
                    p = re.match(rf"{req.mode}-(\d+)__(.+)", c)
                    if p:
                        chunk_number = int(p.group(1))
                        (
                            expanded_collection_name_set.add(
                                f"{req.mode}-{chunk_number - 1}__{p.group(2)}"
                            )
                            if chunk_number > 1
                            else None
                        )
                        expanded_collection_name_set.add(
                            f"{req.mode}-{chunk_number + 1}__{p.group(2)}"
                        )

                expanded_collection_name_set.add(c)
        else:
            expanded_collection_name_set = set(req.collection_name)

        with ThreadPoolExecutor(max_workers=1) as executor:
            future_to_name = {
                executor.submit(search_process, name, req.query): name
                for name in expanded_collection_name_set
            }
            for future in as_completed(future_to_name):
                collection_name = future_to_name[future]
                try:
                    result = future.result()
                    if result:
                        all_results.extend(result)
                except Exception as e:
                    logger.error(
                        f"[RAG] Error in thread for collection '{collection_name}': {e}",
                        exc_info=True,
                    )

        # Step 3: Rerank top N
        if not all_results:
            if config.APP_MODE == "rag-evaluation":
                logger.debug("[RAG] No passages found. Returning empty results.")
            return {"results": []}
        ranked = get_ranked_results(req.query, all_results, top_n=req.top_k)
        if config.APP_MODE == "rag-evaluation":
            logger.debug(f"[RAG] Ranked results: {ranked}")
        logger.info(f"[RAG] search_rag completed.")
        
        # Process version information to merge current and older versions
        formatted_results = _format_results_with_versions(ranked)
        
        return {"results": formatted_results}

    except Exception as e:
        logger.error(f"[RAG] Failed search_rag: {e}", exc_info=True)
        return {"results": [], "error": str(e)}


def _format_results_with_versions(results):
    """
    Format results to include older version information in 'For reference' section.
    Groups results by document name and merges current + older versions into single response.
    """
    if not results:
        return []
    
    # Group results by document name (strip version/date info)
    document_groups = {}
    for result in results:
        metadata = result.get("metadata", {}) if isinstance(result, dict) else {}
        file_name = metadata.get("file_name", "unknown")
        
        # Extract base document name (remove version/date suffixes)
        base_name = _extract_base_document_name(file_name)
        
        if base_name not in document_groups:
            document_groups[base_name] = []
        document_groups[base_name].append(result)
    
    # Sort each group by upload date to identify current vs older versions
    formatted_results = []
    for base_name, group in document_groups.items():
        if len(group) == 1:
            # Single version, just return as-is
            formatted_results.append(group[0])
        else:
            # Multiple versions - merge them with "For reference" section
            # Sort by upload date (newest first)
            sorted_group = sorted(
                group,
                key=lambda x: x.get("metadata", {}).get("upload_date", ""),
                reverse=True
            )
            
            # Create merged result with current version content + "For reference" section
            current_result = sorted_group[0].copy()
            current_content = current_result.get("content", "")
            current_metadata = current_result.get("metadata", {})
            current_file = current_metadata.get("file_name", "unknown")
            
            # Build the reference section for older versions
            reference_parts = []
            for older_result in sorted_group[1:]:
                older_content = older_result.get("content", "")
                older_metadata = older_result.get("metadata", {})
                older_file = older_metadata.get("file_name", "unknown")
                older_date = older_metadata.get("upload_date", "")
                
                reference_parts.append(
                    f"(For reference, the earlier version of the policy states...)\n"
                    f"{older_content}\n"
                    f"[Source: {older_file}]"
                )
            
            # Merge into single response with proper formatting
            if reference_parts:
                merged_content = (
                    f"{current_content}\n"
                    f"[Source: {current_file}]\n\n"
                    f"{chr(10).join(reference_parts)}"
                )
                current_result["content"] = merged_content
            
            formatted_results.append(current_result)
    
    return formatted_results


def _extract_base_document_name(file_name):
    """
    Extract base document name by removing version/date suffixes.
    Examples:
    - "HR_Policy_2024.pdf" -> "HR_Policy"
    - "HR_Policy_2023.pdf" -> "HR_Policy"
    - "manual_v2.3.pdf" -> "manual"
    """
    import re
    
    # Remove date pattern (YYYY-MM-DD or YYYY)
    name = re.sub(r'_\d{4}(-\d{2})?(-\d{2})?(?=\.\w+$)', '', file_name)
    # Remove version pattern (v1, v2.3, etc)
    name = re.sub(r'_v\d+(\.\d+)*(?=\.\w+$)', '', name)
    # Remove file extension
    name = re.sub(r'\.\w+$', '', name)
    
    return name
