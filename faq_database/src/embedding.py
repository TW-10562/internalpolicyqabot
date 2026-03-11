import pandas as pd
from typing import List, Tuple

# Import our custom modules
from src.hotchpotch import EmbeddingWrapper

def generate_question_embeddings(questions: List[str], embedding_model: EmbeddingWrapper) -> List[List[float]]:
    """
    Generate embeddings for all questions using the embedding model.
    
    Args:
        questions: List of question strings
        embedding_model: The embedding model to use
        
    Returns:
        List of embedding vectors
    """
    print(f"Generating embeddings for {len(questions)} questions...")
    
    # Load the model first
    embedding_model._load_model()
    
    # Generate embeddings
    embeddings = embedding_model.encode(questions)
    
    # Convert numpy array to list of lists for ChromaDB
    embeddings_list = embeddings.tolist()
    print(f"Generated embeddings shape: {embeddings.shape}")
    
    return embeddings_list