from typing import Dict, Any

# Import our custom modules
from src.hotchpotch import default_embedding_model, default_cross_encoder
from database.chroma_repository import ChromaRepository
from src.ann import distance_to_similarity


class Pipeline:
    
    def __init__(
        self, 
        repo: ChromaRepository = None, 
        embedding_model=default_embedding_model, 
        cross_encoder=default_cross_encoder
    ):
        """
        Initialize the Pipeline.
        
        Args:
            repo: ChromaRepository instance (required for queries)
            embedding_model: Embedding model (defaults to Japanese sentence-BERT)
            cross_encoder: Cross-encoder for reranking (defaults to hotchpotch cross-encoder)
        """
        self.repo = repo
        self.embedding_model = embedding_model
        self.cross_encoder = cross_encoder
    
    def query_faq_system(
        self,
        user_query: str, 
        repo: ChromaRepository = None, 
        collection_name: str = "faq_collection",
        top_k: int = 3,
        vector_similarity_threshold: float = 0.8,
        cross_encoder_threshold: float = 0.5
    ) -> Dict[str, Any]:
        """
        Complete FAQ query pipeline: vector search + cross-encoder reranking.
        
        Pipeline:
        1. Vectorize user query
        2. ANN search in ChromaDB for top-k similar questions
        3. Rerank using CrossEncoder to get relevance scores
        4. Check similarity thresholds and return best match or "not found"
        
        Args:
            user_query: User's input question
            repo: ChromaRepository instance
            collection_name: Name of the ChromaDB collection
            top_k: Number of candidates to retrieve for reranking
            vector_similarity_threshold: Minimum similarity score for vector search (0.0-1.0)
            cross_encoder_threshold: Minimum cross-encoder score (0.0-1.0)
            
        Returns:
            dict: Best matching result with question, answer, vector_distance, and cross_encoder_score
                or {"not_found": True, "message": "answer not found in FAQs"} if below thresholds
        """
        print(f"\n=== Processing Query: '{user_query}' ===")
        print(f"Query type: {type(user_query)}")
        print(f"Query bytes: {user_query.encode('utf-8')}")
        print(f"Query length: {len(user_query)}")
        
        try:
            # Step 1: Get ChromaDB collection
            repo = self.repo
            if repo is None:
                raise ValueError("No ChromaRepository provided to Pipeline.query_faq_system")
            collection = repo.get_collection(collection_name)
            
            # Step 2: Vectorize user query
            print("Step 1: Vectorizing user query...")
            embedding_model = self.embedding_model
            query_embedding_raw = embedding_model.encode([user_query])
            
            # Handle different return types (numpy array, list, etc.)
            if hasattr(query_embedding_raw, 'tolist'):
                query_embedding = query_embedding_raw.tolist()
            else:
                query_embedding = list(query_embedding_raw) if not isinstance(query_embedding_raw, list) else query_embedding_raw
            
            # Step 3: ANN search for top-k candidates
            print(f"Step 2: Searching for top-{top_k} similar questions...")
            search_results = collection.query(
                query_embeddings=query_embedding,
                n_results=top_k
            )
            
            # Validate search results structure
            if not search_results or not isinstance(search_results, dict):
                return {"error": "Invalid search results format"}
            
            if ('documents' not in search_results or 
                not search_results['documents'] or 
                not search_results['documents'][0]):
                return {"error": "No similar questions found"}
            
            # Extract candidates and calculate similarity scores
            candidates = []
            documents = search_results['documents'][0]
            metadatas = search_results.get('metadatas', [[]])[0]
            distances = search_results.get('distances', [[]])[0]
            
            for i, (question, metadata, distance) in enumerate(zip(
                documents,
                metadatas, 
                distances
            )):
                vector_similarity = distance_to_similarity(distance)
                candidates.append({
                    "question": question,
                    "answer": metadata["answer"],
                    "vector_distance": distance,
                    "vector_similarity": vector_similarity,
                    "index": i
                })
            
            print(f"Found {len(candidates)} candidate questions")
            for i, candidate in enumerate(candidates):
                q_preview = str(candidate['question'])[:50] if candidate.get('question') else 'N/A'
                try:
                    print(f"  {i+1}. {q_preview}... (distance: {candidate['vector_distance']:.4f}, similarity: {candidate['vector_similarity']:.4f})")
                except (TypeError, ValueError) as e:
                    print(f"  {i+1}. {q_preview}... (distance: {candidate.get('vector_distance', 'N/A')}, similarity: {candidate.get('vector_similarity', 'N/A')})")
            
            # Step 4: Check vector similarity threshold for best candidate
            best_vector_candidate = max(candidates, key=lambda x: x["vector_similarity"])
            if best_vector_candidate["vector_similarity"] < vector_similarity_threshold:
                print(f"\nStep 4: Vector similarity too low")
                print(f"  Best vector similarity: {best_vector_candidate['vector_similarity']:.4f}")
                print(f"  Required threshold: {vector_similarity_threshold:.4f}")
                return {
                    "not_found": True,
                    "message": "answer not found in FAQs",
                    "reason": "vector_similarity_too_low",
                    "best_vector_similarity": best_vector_candidate["vector_similarity"],
                    "vector_threshold": vector_similarity_threshold
                }
            
            # Step 5: Rerank using CrossEncoder
            print("Step 4: Reranking with CrossEncoder...")
            cross_encoder = self.cross_encoder
            
            # Calculate cross-encoder scores for each candidate
            for candidate in candidates:
                score = cross_encoder.score(user_query, candidate["question"])
                candidate["cross_encoder_score"] = score
                q_preview = str(candidate['question'])[:40] if candidate.get('question') else 'N/A'
                try:
                    print(f"  Cross-encoder score for '{q_preview}...': {score:.4f}")
                except (TypeError, ValueError):
                    print(f"  Cross-encoder score for '{q_preview}...': {score}")
            
            # Step 6: Find best result and check cross-encoder threshold
            best_result = max(candidates, key=lambda x: x["cross_encoder_score"])
            
            if best_result["cross_encoder_score"] < cross_encoder_threshold:
                print(f"\nStep 5: Cross-encoder score too low")
                print(f"  Best cross-encoder score: {best_result['cross_encoder_score']:.4f}")
                print(f"  Required threshold: {cross_encoder_threshold:.4f}")
                return {
                    "not_found": True,
                    "message": "answer not found in FAQs", 
                    "reason": "cross_encoder_score_too_low",
                    "best_cross_encoder_score": best_result["cross_encoder_score"],
                    "cross_encoder_threshold": cross_encoder_threshold
                }
            
            print(f"\nStep 5: Best match selected:")
            print(f"  Question: {best_result['question']}")
            print(f"  Vector distance: {best_result['vector_distance']:.4f}")
            print(f"  Vector similarity: {best_result['vector_similarity']:.4f}")
            print(f"  Cross-encoder score: {best_result['cross_encoder_score']:.4f}")
            
            return best_result
            
        except Exception as e:
            print(f"Error in query pipeline: {e}")
            return {"error": str(e)}

    def interactive_query_loop(
        self,
        repo: ChromaRepository = None,
        vector_similarity_threshold: float = 0.8,
        cross_encoder_threshold: float = 0.5
    ):
        """
        Interactive loop for querying the FAQ system.
        
        Args:
            repo: ChromaRepository instance
            vector_similarity_threshold: Minimum similarity score for vector search
            cross_encoder_threshold: Minimum cross-encoder score
        """
        print("\n" + "="*50)
        print("   FAQ Interactive Query System")
        print("="*50)
        print("Enter your questions in Japanese. Type 'quit' or 'exit' to stop.")
        print("Examples:")
        print("  - 試用期間について教えてください")
        print("  - 勤務時間は何時間ですか？")
        print("  - 労働契約の更新について")
        print(f"\n⚙️  Current Thresholds:")
        print(f"  - Vector Similarity Threshold: {vector_similarity_threshold:.2f}")
        print(f"  - Cross-Encoder Score Threshold: {cross_encoder_threshold:.2f}")
        print("-" * 50)
        
        while True:
            try:
                # Get user input
                user_query = input("\n🤔 Your question: ").strip()
                
                # Check for exit commands
                if user_query.lower() in ['quit', 'exit', 'q', '終了']:
                    print("👋 Goodbye!")
                    break
                
                if not user_query:
                    print("Please enter a question.")
                    continue
                
                # Process the query
                result = self.query_faq_system(
                    user_query, 
                    repo=repo,
                    vector_similarity_threshold=vector_similarity_threshold,
                    cross_encoder_threshold=cross_encoder_threshold
                )
                
                # Display result
                if "error" in result:
                    print(f"❌ Error: {result['error']}")
                elif "not_found" in result:
                    print("\n" + "="*60)
                    print("🔍 SEARCH RESULT:")
                    print("="*60)
                    print("❌ Answer not found in FAQs")
                    print(f"\nThe query '{user_query}' didn't match any FAQ with sufficient confidence.")
                    print("\n" + "-"*60)
                    print(f"📊 Similarity Analysis:")
                    if result.get("reason") == "vector_similarity_too_low":
                        print(f"   Best Vector Similarity: {result['best_vector_similarity']:.4f}")
                        print(f"   Required Threshold: {result['vector_threshold']:.4f}")
                        print("   → Vector similarity too low")
                    elif result.get("reason") == "cross_encoder_score_too_low":
                        print(f"   Best Cross-Encoder Score: {result['best_cross_encoder_score']:.4f}")
                        print(f"   Required Threshold: {result['cross_encoder_threshold']:.4f}")
                        print("   → Cross-encoder score too low")
                    print("\n💡 Try rephrasing your question or ask about topics covered in the FAQs.")
                else:
                    print("\n" + "="*60)
                    print("📋 ANSWER:")
                    print("="*60)
                    print(result["answer"])
                    print("\n" + "-"*60)
                    print(f"📊 Confidence Metrics:")
                    print(f"   Vector Distance: {result['vector_distance']:.4f} (lower is better)")
                    print(f"   Vector Similarity: {result['vector_similarity']:.4f} (higher is better)")
                    print(f"   Cross-Encoder Score: {result['cross_encoder_score']:.4f} (higher is better)")
                    print(f"   Matched Question: {result['question']}")
                    
            except KeyboardInterrupt:
                print("\n👋 Goodbye!")
                break
            except EOFError:
                print("\n👋 Goodbye!")
                break
            except Exception as e:
                print(f"❌ Unexpected error: {e}")

