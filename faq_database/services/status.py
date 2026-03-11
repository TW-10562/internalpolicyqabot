#!/usr/bin/env python3
"""
FAQ Status/Stats service
"""

from fastapi import APIRouter, HTTPException, status
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.schema import StatsResponse
from database.chroma_repository import ChromaRepository

router = APIRouter()

# Global variables
repo = None


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


@router.get("/stats", response_model=StatsResponse, tags=["Information"])
async def get_stats():
    """Get FAQ database statistics."""
    try:
        if not initialize_faq_system():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="FAQ database not available. Please build the database first using POST /reconstruct with an Excel file."
            )
        
        collection = repo.get_collection("faq_collection")
        count = collection.count()
        
        return StatsResponse(total_faqs=count)
    
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
