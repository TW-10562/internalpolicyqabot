#!/usr/bin/env python3
"""
Feedback service - handles user feedback to save or delete FAQ based on cache_signal
"""

from fastapi import APIRouter, HTTPException, status
import sys
import os
import numpy as np

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.schema import FeedbackRequest, FeedbackResponse, SaveFAQRequest, DeleteFAQRequest
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
        print("Initializing FAQ cache system for feedback...")
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


def find_similar_question(query: str, threshold: float = 0.85):
    """
    Search for similar questions in the cache (for SAVE operation).
    Only checks question similarity, not answer.
    
    Args:
        query: The question to search for
        threshold: Similarity threshold (default 0.85)
    
    Returns:
        tuple: (found: bool, similarity: float, matched_question: str, matched_answer: str)
    """
    try:
        collection = repo.get_collection("faq_collection")
        
        # Get all documents for exact match check
        all_results = collection.get(include=['documents', 'metadatas'])
        
        if not all_results['documents']:
            return False, 0.0, None, None
        
        # Check for exact match first
        query_normalized = query.lower().strip()
        for i, doc in enumerate(all_results['documents']):
            metadata = all_results['metadatas'][i] if i < len(all_results['metadatas']) else {}
            stored_question = metadata.get('question', '').strip()
            stored_answer = metadata.get('answer', '').strip()
            
            if stored_question.lower().strip() == query_normalized:
                print(f"[FEEDBACK] Found exact question match")
                return True, 1.0, stored_question, stored_answer
        
        # Perform semantic similarity search
        from src.hotchpotch import EmbeddingWrapper
        embedder = EmbeddingWrapper(model_id="sonoisa/sentence-bert-base-ja-mean-tokens-v2")
        query_embedding = embedder.encode([query])
        
        # Search for similar questions
        similar_results = collection.query(
            query_embeddings=query_embedding.tolist(),
            n_results=1,
            include=['documents', 'metadatas', 'distances']
        )
        
        if similar_results['documents'] and similar_results['documents'][0]:
            distance = similar_results['distances'][0][0]
            metadata = similar_results['metadatas'][0][0]
            
            # Convert distance to similarity score
            similarity = 1.0 / (1.0 + distance)
            
            stored_question = metadata.get('question', '').strip()
            stored_answer = metadata.get('answer', '').strip()
            
            print(f"[FEEDBACK] Question similarity: {similarity:.3f} (threshold: {threshold})")
            
            if similarity >= threshold:
                return True, similarity, stored_question, stored_answer
        
        return False, 0.0, None, None
        
    except Exception as e:
        print(f"[FEEDBACK] Error in question similarity search: {e}")
        return False, 0.0, None, None


def find_similar_qa_pair(query: str, answer: str, threshold: float = 0.90):
    """
    Search for similar Q&A pairs in the cache (for DELETE operation).
    Checks both question AND answer similarity.
    
    Args:
        query: The question to search for
        answer: The answer to compare
        threshold: Similarity threshold (default 0.90, stricter than save)
    
    Returns:
        tuple: (found: bool, similarity: float, matched_question: str, matched_answer: str)
    """
    try:
        collection = repo.get_collection("faq_collection")
        
        # Get all documents
        all_results = collection.get(include=['documents', 'metadatas'])
        
        if not all_results['documents']:
            return False, 0.0, None, None
        
        from src.hotchpotch import EmbeddingWrapper
        embedder = EmbeddingWrapper(model_id="sonoisa/sentence-bert-base-ja-mean-tokens-v2")
        
        # Encode the user's query and answer
        query_embedding = embedder.encode([query])[0]
        answer_embedding = embedder.encode([answer])[0]
        
        best_similarity = 0.0
        best_question = None
        best_answer = None
        
        # Check each Q&A pair in the cache
        for i, doc in enumerate(all_results['documents']):
            metadata = all_results['metadatas'][i] if i < len(all_results['metadatas']) else {}
            stored_question = metadata.get('question', '').strip()
            stored_answer = metadata.get('answer', '').strip()
            
            if not stored_question or not stored_answer:
                continue
            
            # Encode stored Q&A
            stored_q_embedding = embedder.encode([stored_question])[0]
            stored_a_embedding = embedder.encode([stored_answer])[0]
            
            # Calculate cosine similarity for question
            q_similarity = np.dot(query_embedding, stored_q_embedding) / (
                np.linalg.norm(query_embedding) * np.linalg.norm(stored_q_embedding)
            )
            
            # Calculate cosine similarity for answer
            a_similarity = np.dot(answer_embedding, stored_a_embedding) / (
                np.linalg.norm(answer_embedding) * np.linalg.norm(stored_a_embedding)
            )
            
            # Combined similarity (weighted average: 40% question, 60% answer)
            # Answer is more important because user is judging answer quality
            combined_similarity = 0.4 * q_similarity + 0.6 * a_similarity
            
            if combined_similarity > best_similarity:
                best_similarity = combined_similarity
                best_question = stored_question
                best_answer = stored_answer
        
        print(f"[FEEDBACK] Q&A pair similarity: {best_similarity:.3f} (threshold: {threshold})")
        
        if best_similarity >= threshold:
            return True, best_similarity, best_question, best_answer
        
        return False, 0.0, None, None
        
    except Exception as e:
        print(f"[FEEDBACK] Error in Q&A pair similarity search: {e}")
        import traceback
        traceback.print_exc()
        return False, 0.0, None, None


@router.post("/feedback", response_model=FeedbackResponse, tags=["Feedback"])
async def process_feedback(request: FeedbackRequest):
    """
    Process user feedback based on cache_signal.
    
    - cache_signal = 1 (positive): Save to cache if no similar question exists
    - cache_signal = 0 (negative): Delete from cache if similar question exists
    """
    try:
        # Initialize FAQ system if needed
        if not initialize_faq_system():
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="FAQ system not initialized"
            )
        
        cache_signal = request.cache_signal
        query = request.query
        answer = request.answer
        save_threshold = request.save_threshold
        delete_threshold = request.delete_threshold
        
        print(f"\n[FEEDBACK] Processing feedback: signal={cache_signal}, query='{query[:50]}...'")
        print(f"[FEEDBACK] Thresholds: save={save_threshold:.2f} (question only), delete={delete_threshold:.2f} (Q&A pair)")
        
        # Process based on cache_signal
        if cache_signal == 1:
            # Positive feedback: Save if no similar question exists
            # Only check question similarity
            similar_found, similarity_score, matched_question, matched_answer = find_similar_question(
                query, save_threshold
            )
            if similar_found:
                print(f"[FEEDBACK] Similar question already exists (similarity: {similarity_score:.3f}), no action taken")
                return FeedbackResponse(
                    success=True,
                    message=f"Similar question already exists in cache (similarity: {similarity_score:.3f})",
                    action_taken="no_action",
                    cache_signal=cache_signal,
                    similar_found=True,
                    similarity_score=similarity_score,
                    matched_question=matched_question,
                    details={
                        "reason": "duplicate_detected",
                        "matched_answer": matched_answer[:100] + "..." if matched_answer and len(matched_answer) > 100 else matched_answer
                    }
                )
            else:
                # No similar question found, save it
                if not answer:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Answer is required when cache_signal=1"
                    )
                
                print(f"[FEEDBACK] No similar question found, saving to cache...")
                
                # Use the existing save logic
                from services.save import save_faq
                save_request = SaveFAQRequest(question=query, answer=answer)
                save_response = await save_faq(save_request)
                
                if save_response.success:
                    return FeedbackResponse(
                        success=True,
                        message="FAQ saved successfully to cache",
                        action_taken="saved",
                        cache_signal=cache_signal,
                        similar_found=False,
                        details={
                            "faq_id": save_response.faq_id,
                            "question": query,
                            "answer_length": len(answer)
                        }
                    )
                else:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail=f"Failed to save FAQ: {save_response.message}"
                    )
        
        elif cache_signal == 0:
            # Negative feedback: Delete if similar Q&A pair exists
            # Check both question AND answer similarity
            if not answer:
                # If no answer provided, fall back to question-only matching
                print(f"[FEEDBACK] Warning: No answer provided for delete operation, using question-only matching")
                similar_found, similarity_score, matched_question, matched_answer = find_similar_question(
                    query, delete_threshold
                )
            else:
                similar_found, similarity_score, matched_question, matched_answer = find_similar_qa_pair(
                    query, answer, delete_threshold
                )
            
            if not similar_found:
                print(f"[FEEDBACK] No similar Q&A pair found in cache, no action taken")
                return FeedbackResponse(
                    success=True,
                    message="No similar Q&A pair found in cache",
                    action_taken="no_action",
                    cache_signal=cache_signal,
                    similar_found=False,
                    details={
                        "reason": "no_match_found"
                    }
                )
            else:
                # Similar question found, delete it
                print(f"[FEEDBACK] Similar question found (similarity: {similarity_score:.3f}), deleting from cache...")
                
                # Use the existing delete logic
                from services.delete import delete_faq
                delete_request = DeleteFAQRequest(question=matched_question)
                delete_response = await delete_faq(delete_request)
                
                if delete_response.success:
                    return FeedbackResponse(
                        success=True,
                        message=f"FAQ deleted successfully from cache (similarity: {similarity_score:.3f})",
                        action_taken="deleted",
                        cache_signal=cache_signal,
                        similar_found=True,
                        similarity_score=similarity_score,
                        matched_question=matched_question,
                        details={
                            "deleted_count": delete_response.deleted_count,
                            "remaining_count": delete_response.remaining_count,
                            "deleted_items": [
                                {
                                    "question": item.question,
                                    "answer_preview": item.answer[:100] + "..." if len(item.answer) > 100 else item.answer
                                }
                                for item in (delete_response.deleted_items or [])
                            ]
                        }
                    )
                else:
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail=f"Failed to delete FAQ: {delete_response.message}"
                    )
        
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid cache_signal value. Must be 0 or 1"
            )
    
    except HTTPException:
        raise
    except Exception as e:
        print(f"[FEEDBACK] Error processing feedback: {str(e)}")
        import traceback
        traceback.print_exc()
        
        return FeedbackResponse(
            success=False,
            message="Error processing feedback",
            action_taken="error",
            cache_signal=request.cache_signal,
            similar_found=False,
            error=str(e)
        )
