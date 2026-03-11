#!/usr/bin/env python3
"""
FAQ Reconstruct service
"""

from fastapi import APIRouter, HTTPException, status
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.schema import ReconstructRequest, ReconstructResponse
from database.chroma_repository import ChromaRepository
from pipeline import Pipeline
from src.db_reconstruction import get_reconstructor

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


@router.post("/reconstruct", response_model=ReconstructResponse, tags=["Database Management"])
async def reconstruct_database(request: ReconstructRequest):
    """
    Reconstruct the FAQ database from an Excel file.
    
    This endpoint:
    1. Backs up the existing database (if requested)
    2. Loads FAQ data from the provided Excel file
    3. Generates embeddings for all questions
    4. Stores the data in ChromaDB, replacing the existing collection
    
    **Note:** This is a destructive operation. All existing FAQ data will be replaced.
    A backup is created by default for safety.
    
    **Excel File Format:**
    - Must contain columns: 'question' (or 'questions') and 'answer'
    - Questions should be in Japanese
    - Answers can be multi-line text
    
    **Example Excel path:** `files/faq_10.xlsx`
    """
    try:
        print(f"[RECONSTRUCT] Starting database reconstruction from: {request.excel_path}")
        
        # Get the reconstructor instance
        reconstructor = get_reconstructor(db_path=".database/chroma_db")
        
        # Perform reconstruction
        result = reconstructor.reconstruct_from_excel(
            excel_path=request.excel_path,
            collection_name=request.collection_name,
            backup_existing=request.backup_existing
        )
        
        if not result.get("success"):
            error_msg = result.get("error", "Unknown error during reconstruction")
            print(f"[RECONSTRUCT] Failed: {error_msg}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=error_msg
            )
        
        # Reinitialize the global FAQ system to use the new data
        global repo, pipeline
        repo = None  # Force reinitialization
        if initialize_faq_system():
            print("[RECONSTRUCT] FAQ system reinitialized with new data")
        else:
            print("[RECONSTRUCT] Warning: Failed to reinitialize FAQ system")
        
        print(f"[RECONSTRUCT] Successfully reconstructed database with {result.get('items_processed')} items")
        
        return ReconstructResponse(
            success=True,
            message=result.get("message", "Database reconstructed successfully"),
            items_processed=result.get("items_processed"),
            collection_name=result.get("collection_name"),
            excel_path=result.get("excel_path"),
            backup_created=result.get("backup_created")
        )
    
    except HTTPException:
        raise
    except Exception as e:
        error_msg = f"Failed to reconstruct database: {str(e)}"
        print(f"[RECONSTRUCT] Error: {error_msg}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=error_msg
        )
