import os
import numpy as np

class EmbeddingWrapper:
    """Lightweight wrapper for sentence-transformers SentenceTransformer.
    
    Features:
    - Lazy loads the SentenceTransformer model on first use.
    - Provides encode(texts) -> np.ndarray method to generate embeddings.
    """
    def __init__(self, model_id="sonoisa/sentence-bert-base-ja-mean-tokens-v2"):
        self.model_id = model_id
        self._model = None

    def _load_model(self):
        if self._model is not None:
            return
        try:
            print(f"Loading embedding model: {self.model_id} (this may take time on first run)")
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer(self.model_id)
            print(f"Successfully loaded embedding model: {self.model_id}")
        except Exception as e:
            # Surface the error to caller instead of silently defaulting to 384-dim vectors.
            print(f"Error: Embedding model load failed: {e}")
            raise

    def encode(self, texts):
        """Generate embeddings for a list of texts.
        
        Args:
            texts: List of strings to encode
            
        Returns:
            np.ndarray: Array of embeddings, shape (len(texts), embedding_dim)
        """
        if not texts:
            return np.array([])
        
        self._load_model()
        if self._model is None:
            # If model isn't loaded, raise an error so caller can handle it explicitly.
            raise RuntimeError("Embedding model is not loaded")
        
        try:
            embeddings = self._model.encode(texts, convert_to_numpy=True)
            return embeddings
        except Exception as e:
            print(f"Warning: Embedding generation failed: {e}")
            raise

class CrossEncoderWrapper:
    """Lightweight wrapper for a sentence-transformers CrossEncoder.

    Features:
    - Lazy loads the CrossEncoder model on first use.
    - Honors COMPUTE_EXPENSIVE_METRICS env var (skip if false).
    - Provides score(pred, ref) -> float and batch_score(pairs) -> list[float].
    """
    def __init__(self, model_id="hotchpotch/japanese-reranker-cross-encoder-base-v1"):
        self.model_id = model_id
        self._model = None
        # Do not cache COMPUTE_EXPENSIVE_METRICS here; check dynamically in methods

    def _load_model(self):
        if self._model is not None:
            return
        try:
            from sentence_transformers import CrossEncoder
            self._model = CrossEncoder(self.model_id)
        except Exception as e:
            # If model cannot be loaded, set to None and log via print (caller will handle gracefully)
            print(f"Info: CrossEncoder load failed: {e}")
            self._model = None

    def score(self, pred, ref):
        """Return a single cross-encoder score for pred vs ref as float.

        Returns 0.0 if gating disabled, inputs invalid, or model isn't available.
        """
        if os.getenv("COMPUTE_EXPENSIVE_METRICS", "1") != "1":
            return 0.0
        if pred is None or ref is None:
            return 0.0
        self._load_model()
        if self._model is None:
            return 0.0
        try:
            out = self._model.predict([[str(pred), str(ref)]])
            if isinstance(out, (list, tuple, np.ndarray)):
                return float(out[0])
            return float(out)
        except Exception as e:
            print(f"Warning: CrossEncoder scoring failed: {e}")
            return 0.0

# Convenience singleton for quick imports



class HotchPotch:
    """High-level service class that bundles embedding and cross-encoder wrappers.

    Provides convenience methods that operate across models and the Chroma repository.
    """
    def __init__(self, embedding_wrapper: EmbeddingWrapper = None, cross_encoder: CrossEncoderWrapper = None):
        self.embedding = embedding_wrapper or default_embedding_model
        self.cross_encoder = cross_encoder or default_cross_encoder

    def test_similarity_search(self, repo, test_question: str, collection_name: str = "faq_collection"):
        """
        Test similarity search using the bundled embedding model and provided ChromaRepository.

        Args:
            repo: ChromaRepository instance
            test_question: text to query
            collection_name: collection name in ChromaDB
        """
        print(f"\nTesting similarity search with question: '{test_question}'")
        try:
            collection = repo.get_collection(collection_name)

            # Generate embedding for test question
            test_embedding = self.embedding.encode([test_question]).tolist()

            # Search for similar items
            results = collection.query(
                query_embeddings=test_embedding,
                n_results=3
            )

            print(f"Found {len(results['documents'][0])} similar questions:")
            for i, (doc, metadata, distance) in enumerate(zip(
                results['documents'][0],
                results['metadatas'][0],
                results['distances'][0]
            )):
                print(f"\n{i+1}. Question: {doc}")
                print(f"   Answer: {metadata.get('answer', '')[:100]}...")
                print(f"   Distance: {distance:.4f}")

        except Exception as e:
            print(f"Error during similarity search: {e}")


default_cross_encoder = CrossEncoderWrapper()
default_embedding_model = EmbeddingWrapper()
default_hotchpotch = HotchPotch()


