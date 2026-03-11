#!/usr/bin/env python3
"""
FAQ Save service
"""

from fastapi import APIRouter, HTTPException, status
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.schema import SaveFAQRequest, SaveFAQResponse, ExistingFAQ
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


@router.post("/save", response_model=SaveFAQResponse, tags=["FAQ Management"])
async def save_faq(request: SaveFAQRequest):
    """
    Save a new FAQ to the cache.
    
    Performs duplicate detection using both exact matching and semantic similarity.
    Returns information about existing FAQ if duplicate is detected.
    """
    try:
        # Initialize FAQ system if needed
        if not initialize_faq_system():
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="FAQ system not initialized"
            )
        
        question = request.question
        answer = request.answer
        
        print(f"Saving FAQ: Q='{question}' A='{answer[:100]}...'")
        
        # Check for duplicates using comprehensive approach
        try:
            # Method 1: Direct collection query for more comprehensive duplicate detection
            collection = repo.get_collection("faq_collection")
            all_results = collection.get(include=['documents', 'metadatas'])
            
            # Check for exact matches first
            if all_results['documents']:
                for i, doc in enumerate(all_results['documents']):
                    metadata = all_results['metadatas'][i] if i < len(all_results['metadatas']) else {}
                    stored_question = metadata.get('question', '').strip()
                    stored_answer = metadata.get('answer', '').strip()
                    
                    # Exact string match (case-insensitive and whitespace-normalized)
                    if (stored_question.lower().strip() == question.lower().strip() and 
                        stored_answer.lower().strip() == answer.lower().strip()):
                        print(f"🔄 Exact duplicate FAQ detected, skipping save")
                        return SaveFAQResponse(
                            success=True,
                            message="FAQ already exists (exact duplicate detected)",
                            duplicate_detected=True,
                            existing_faq=ExistingFAQ(
                                question=stored_question,
                                answer=stored_answer
                            )
                        )
            
            # Method 2: Semantic similarity check using vector search
            from src.hotchpotch import EmbeddingWrapper
            embedder = EmbeddingWrapper(model_id="sonoisa/sentence-bert-base-ja-mean-tokens-v2")
            query_embedding = embedder.encode([question])
            
            # Search for similar questions with lower threshold for duplicate detection
            similar_results = collection.query(
                query_embeddings=query_embedding.tolist(),
                n_results=3,
                include=['documents', 'metadatas', 'distances']
            )
            
            if similar_results['documents'] and similar_results['documents'][0]:
                for i, (doc, metadata, distance) in enumerate(zip(
                    similar_results['documents'][0],
                    similar_results['metadatas'][0], 
                    similar_results['distances'][0]
                )):
                    # Convert distance to similarity (assuming L2 distance)
                    similarity = 1.0 / (1.0 + distance)
                    
                    if similarity > 0.85:  # High similarity threshold
                        stored_question = metadata.get('question', '').strip()
                        stored_answer = metadata.get('answer', '').strip()
                        
                        # Check if answers are also very similar
                        if stored_answer == answer:
                            print(f"🔄 Duplicate FAQ detected via similarity (sim={similarity:.3f}), skipping save")
                            return SaveFAQResponse(
                                success=True,
                                message="FAQ already exists (similar question with same answer)",
                                duplicate_detected=True,
                                similarity_score=similarity,
                                existing_faq=ExistingFAQ(
                                    question=stored_question,
                                    answer=stored_answer
                                )
                            )
                        
                        # Check for very similar answers using character overlap
                        answer_clean = ''.join(answer.split()).lower()
                        stored_clean = ''.join(stored_answer.split()).lower()
                        
                        if answer_clean and stored_clean:
                            # Calculate character-level similarity
                            common_chars = sum(1 for a, b in zip(answer_clean, stored_clean) if a == b)
                            char_similarity = common_chars / max(len(answer_clean), len(stored_clean))
                            
                            if char_similarity > 0.9:
                                print(f"🔄 Very similar FAQ detected (q_sim={similarity:.3f}, a_sim={char_similarity:.3f}), skipping save")
                                return SaveFAQResponse(
                                    success=True,
                                    message="Very similar FAQ already exists",
                                    duplicate_detected=True,
                                    similarity_scores={
                                        "question": similarity,
                                        "answer": char_similarity
                                    },
                                    existing_faq=ExistingFAQ(
                                        question=stored_question,
                                        answer=stored_answer
                                    )
                                )
            
        except Exception as dup_check_error:
            print(f"⚠️ Duplicate check failed (proceeding with save): {dup_check_error}")
        
        # Get the collection
        collection = repo.get_collection("faq_collection")
        
        # Generate embedding for the question using the same model as existing data
        from src.hotchpotch import EmbeddingWrapper
        embedder = EmbeddingWrapper(model_id="sonoisa/sentence-bert-base-ja-mean-tokens-v2")
        question_embedding = embedder.encode([question])[0].tolist()
        
        # Generate a unique ID
        import time
        faq_id = f"faq_{int(time.time() * 1000)}"
        
        # Add to collection
        collection.add(
            ids=[faq_id],
            embeddings=[question_embedding],
            metadatas=[{"question": question, "answer": answer}],
            documents=[question]
        )
        
        print(f"✅ FAQ saved with ID: {faq_id}")
        
        return SaveFAQResponse(
            success=True,
            message="FAQ saved successfully",
            faq_id=faq_id,
            duplicate_detected=False
        )
    
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error saving FAQ: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
