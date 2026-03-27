#!/usr/bin/env python3
"""
FAQ Delete service
"""

from fastapi import APIRouter, HTTPException, status
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.schema import DeleteFAQRequest, DeleteFAQResponse, DeletedItem
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


@router.post("/delete", response_model=DeleteFAQResponse, tags=["FAQ Management"])
async def delete_faq(request: DeleteFAQRequest):
    """
    Delete FAQ entry from cache by recreating collection without matching entries.
    
    Matches based on question text (exact or high similarity match).
    """
    try:
        # Initialize FAQ system if needed
        if not initialize_faq_system():
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="FAQ system not initialized"
            )
        
        target_question = request.question
        
        print(f"[DELETE] Looking for FAQ to delete by question: Q='{target_question[:50]}...'")
        
        # Get the collection
        collection = repo.get_collection("faq_collection")
        
        # Get all documents from collection
        all_results = collection.get(include=['documents', 'metadatas'])
        
        if not all_results['documents']:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No FAQs found in collection"
            )
        
        # Find matching entries to delete - now only based on question
        items_to_keep = []
        items_deleted = 0
        deleted_items = []  # Track what was deleted
        
        # Initialize embedder for similarity comparison
        from src.hotchpotch import EmbeddingWrapper
        embedder = EmbeddingWrapper(model_id="sonoisa/sentence-bert-base-ja-mean-tokens-v2")
        target_embedding = embedder.encode([target_question])[0]
        
        for i, doc in enumerate(all_results['documents']):
            metadata = all_results['metadatas'][i] if i < len(all_results['metadatas']) else {}
            stored_question = metadata.get('question', '').strip()
            stored_answer = metadata.get('answer', '').strip()
            
            should_delete = False
            
            # Check for exact question match (ignore answer)
            if stored_question.lower().strip() == target_question.lower().strip():
                print(f"[DELETE] Found exact question match to delete: Q='{stored_question[:50]}...'")
                should_delete = True
                deleted_items.append(DeletedItem(
                    question=stored_question,
                    answer=stored_answer[:100] + "..." if len(stored_answer) > 100 else stored_answer
                ))
            else:
                # Check similarity for near-matches (only for question)
                if stored_question:
                    try:
                        stored_embedding = embedder.encode([stored_question])[0]
                        
                        # Calculate cosine similarity
                        import numpy as np
                        similarity = np.dot(target_embedding, stored_embedding) / (
                            np.linalg.norm(target_embedding) * np.linalg.norm(stored_embedding)
                        )
                        
                        # High similarity threshold for deletion safety (only question-based)
                        if similarity > 0.95:
                            print(f"[DELETE] Found high similarity question match to delete: Q='{stored_question[:50]}...' (similarity: {similarity:.3f})")
                            should_delete = True
                            deleted_items.append(DeletedItem(
                                question=stored_question,
                                answer=stored_answer[:100] + "..." if len(stored_answer) > 100 else stored_answer,
                                similarity=similarity
                            ))
                    except Exception as e:
                        print(f"[DELETE] Error calculating similarity: {e}")
            
            if should_delete:
                items_deleted += 1
            else:
                # Keep this item
                items_to_keep.append({
                    'document': doc,
                    'metadata': metadata,
                    'id': all_results['ids'][i] if i < len(all_results['ids']) else f"doc_{i}"
                })
        
        if items_deleted == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No matching FAQ found to delete for question: {target_question}"
            )
        
        # Recreate collection with remaining items
        print(f"[DELETE] Recreating collection with {len(items_to_keep)} items (deleted {items_deleted} items)")
        
        # Delete the old collection
        try:
            repo.client.delete_collection(name="faq_collection")
            print("[DELETE] Old collection deleted")
        except Exception as e:
            print(f"[DELETE] Collection deletion warning: {e}")
        
        # Create new collection
        new_collection = repo.get_or_create_collection("faq_collection")
        
        # Update pipeline to use new collection by reinitializing it
        global pipeline
        pipeline = Pipeline(repo=repo)
        
        # Re-add remaining items with embeddings to preserve collection dimensionality
        if items_to_keep:
            documents = []
            metadatas = []
            ids = []
            embeddings = []

            # Use the same embedder to generate embeddings for stored questions
            for i, item in enumerate(items_to_keep):
                documents.append(item['document'])
                metadatas.append(item['metadata'])
                ids.append(f"faq_{i}")  # Generate new sequential IDs
                # Compute embedding for the stored question if possible
                try:
                    stored_q = item['metadata'].get('question', '')
                    if stored_q:
                        emb = embedder.encode([stored_q])[0].tolist()
                    else:
                        emb = [0.0]
                except Exception as e:
                    print(f"[DELETE] Warning: failed to encode stored question: {e}")
                    emb = [0.0]

                embeddings.append(emb)

            # Add back with embeddings using repository safe_add to ensure dimensionality
            try:
                repo.safe_add(
                    collection_name="faq_collection",
                    documents=documents,
                    metadatas=metadatas,
                    ids=ids,
                    embeddings=embeddings,
                )
                print(f"[DELETE] Re-added {len(items_to_keep)} items to new collection with embeddings")
            except ValueError as ve:
                # Dimension mismatch or other issue; return informative error
                print(f"[DELETE] Dimension mismatch when re-adding items: {ve}")
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Dimension mismatch when rebuilding collection: {ve}"
                )
        
        return DeleteFAQResponse(
            success=True,
            message=f"Successfully deleted {items_deleted} FAQ entry/entries based on question matching",
            deleted_count=items_deleted,
            remaining_count=len(items_to_keep),
            deleted_items=deleted_items,
            search_criteria="question_only"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"[DELETE] Error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete FAQ: {str(e)}"
        )
