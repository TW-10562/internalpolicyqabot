def distance_to_similarity(distance: float, max_distance: float = 1000.0) -> float:
    """
    Convert Euclidean distance to similarity score (0-1 range).
    
    Args:
        distance: Euclidean distance from vector search
        max_distance: Maximum expected distance for normalization
        
    Returns:
        float: Similarity score between 0.0 and 1.0 (higher = more similar)
    """
    # Convert distance to similarity: similarity = 1 - (distance / max_distance)
    # Clamp to [0, 1] range
    similarity = max(0.0, min(1.0, 1.0 - (distance / max_distance)))
    return similarity