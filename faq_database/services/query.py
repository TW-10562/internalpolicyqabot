#!/usr/bin/env python3
"""
FAQ Query service
"""

from fastapi import APIRouter, HTTPException, status
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.schema import QueryRequest, QueryResponse, ConfidenceInfo
from database.chroma_repository import ChromaRepository
from pipeline import Pipeline

router = APIRouter()

# Global variables for reuse
repo = None
pipeline = None


def initialize_faq_system(silent_fail: bool = False):
    """
    Initialize the FAQ system components.
    
    Args:
        silent_fail: If True, returns False silently when DB not found (for startup checks).
                     If False, returns False with error message (for request handlers).
    
    Returns:
        True if initialized successfully, False otherwise.
    """
    global repo, pipeline
    
    if repo is None:
        import os
        db_path = "./database/chroma_db"
        
        # Check if database exists
        if not os.path.exists(os.path.join(db_path, "chroma.sqlite3")):
            if not silent_fail:
                print("⚠️  FAQ database not found. Database will be initialized on first use.")
            return False
        
        try:
            print("Initializing FAQ cache system...")
            repo = ChromaRepository(db_path=db_path)
            collection = repo.get_collection("faq_collection")
            pipeline = Pipeline(repo=repo)
            print(f"✅ FAQ cache system initialized with {collection.count()} items")
            return True
        except Exception as e:
            if not silent_fail:
                print(f"❌ Error initializing FAQ system: {e}")
            return False
    
    return True


@router.post("/query", response_model=QueryResponse, tags=["FAQ Query"])
async def query_faq(request: QueryRequest):
    """
    Query the FAQ cache for a given user question.
    
    Uses semantic search to find matching FAQs with configurable thresholds.
    Returns cached answer if match is found, otherwise indicates cache miss.
    """
    try:
        # Initialize FAQ system if needed (will fail if DB doesn't exist)
        if not initialize_faq_system():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="FAQ database not available. Please build the database first using POST /reconstruct with an Excel file."
            )
        
        user_query = request.query
        vector_similarity_threshold = request.vector_similarity_threshold
        cross_encoder_threshold = request.cross_encoder_threshold
        
        # Enhanced debugging for encoding issues
        print(f"FAQ Cache Query: '{user_query}'")
        print(f"Query type: {type(user_query)}")
        print(f"Query length: {len(user_query)}")
        print(f"Query encoding check: {user_query.encode('utf-8')}")
        print(f"Thresholds: vector={vector_similarity_threshold}, cross_encoder={cross_encoder_threshold}")
        
        # Query the FAQ system
        result = pipeline.query_faq_system(
            user_query=user_query,
            repo=repo,
            vector_similarity_threshold=vector_similarity_threshold,
            cross_encoder_threshold=cross_encoder_threshold
        )
        
        # Process result
        if "error" in result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["error"]
            )
        
        elif "not_found" in result:
            # Cache miss
            return QueryResponse(
                cache_hit=False,
                message=result["message"],
                reason=result.get("reason", "unknown"),
                confidence=ConfidenceInfo(
                    vector_similarity=result.get("best_vector_similarity"),
                    cross_encoder_score=result.get("best_cross_encoder_score"),
                    vector_threshold=result.get("vector_threshold"),
                    cross_encoder_threshold=result.get("cross_encoder_threshold")
                )
            )
        
        else:
            # Cache hit
            return QueryResponse(
                cache_hit=True,
                answer=result["answer"],
                question=result["question"],
                confidence=ConfidenceInfo(
                    vector_similarity=result["vector_similarity"],
                    cross_encoder_score=result["cross_encoder_score"],
                    vector_distance=result["vector_distance"]
                )
            )
    
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in query_faq: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
