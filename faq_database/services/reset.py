#!/usr/bin/env python3
"""
FAQ Reset service
"""

from fastapi import APIRouter, HTTPException, status
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.schema import ResetResponse
from database.chroma_repository import ChromaRepository
from pipeline import Pipeline

router = APIRouter()

# Global variables
repo = None
pipeline = None


def initialize_faq_system():
    """Initialize the FAQ system components."""
    global repo, pipeline
    
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
            pipeline = Pipeline(repo=repo)
            print(f"✅ FAQ cache system initialized with {collection.count()} items")
            return True
        except Exception as e:
            print(f"❌ Error initializing FAQ system: {e}")
            return False
    
    return True


@router.post("/reset", response_model=ResetResponse, tags=["FAQ Management"])
async def reset_collection():
    """Reset the FAQ collection to fix embedding dimension issues."""
    try:
        global repo, pipeline
        
        if not repo:
            if not initialize_faq_system():
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to initialize FAQ system"
                )
        
        print("[RESET] Resetting FAQ collection...")
        
        # Delete the old collection
        try:
            repo.client.delete_collection(name="faq_collection")
            print("[RESET] Old collection deleted")
        except Exception as e:
            print(f"[RESET] Collection deletion warning: {e}")
        
        # Create new collection with correct embedding model
        new_collection = repo.get_or_create_collection("faq_collection")
        print("[RESET] New collection created")
        
        return ResetResponse(
            success=True,
            message="FAQ collection reset successfully",
            collection_name="faq_collection"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"[RESET] Error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to reset collection: {str(e)}"
        )
