#!/usr/bin/env python3
"""
FAQ Database Main Application

This script reads FAQ data from Excel file, generates embeddings for questions,
and stores them in ChromaDB for similarity search.
"""

import os
import sys
import signal

if __name__ == '__main__':
    import uvicorn

    # ========================================
    # Configuration: Threshold Parameters
    # ========================================
    # These thresholds control the FAQ matching behavior
    
    # Query endpoint thresholds (for /query endpoint)
    VECTOR_SIMILARITY_THRESHOLD = 0.8
    CROSS_ENCODER_THRESHOLD = 0.5
    
    # Feedback endpoint thresholds (for /feedback endpoint)
    FEEDBACK_SAVE_THRESHOLD = 0.85      # For checking question similarity when saving
    FEEDBACK_DELETE_THRESHOLD = 0.80     # For checking Q&A pair similarity when deleting (stricter)
    
    # Set environment variables for use in other modules
    os.environ['VECTOR_SIMILARITY_THRESHOLD'] = str(VECTOR_SIMILARITY_THRESHOLD)
    os.environ['CROSS_ENCODER_THRESHOLD'] = str(CROSS_ENCODER_THRESHOLD)
    os.environ['FEEDBACK_SAVE_THRESHOLD'] = str(FEEDBACK_SAVE_THRESHOLD)
    os.environ['FEEDBACK_DELETE_THRESHOLD'] = str(FEEDBACK_DELETE_THRESHOLD)
    
    port = int(os.environ.get('FAQ_CACHE_PORT', 8001))

    def signal_handler(sig, frame):
        """Handle Ctrl+C (SIGINT) and SIGTERM for graceful shutdown."""
        sig_name = 'SIGINT' if sig == signal.SIGINT else 'SIGTERM'
        print(f"\n\n👋 Received {sig_name}, shutting down gracefully...")
        sys.exit(0)

    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    print("=" * 60)
    print("FAQ Database Initialization")
    print("=" * 60)
    print("\n🔄 Reconstructing FAQ database from Excel file...")
    
    try:
        from src.db_reconstruction import get_reconstructor
        
        # Get the default Excel file path
        excel_path = os.environ.get('FAQ_EXCEL_PATH', 'files/faq_10.xlsx')
        
        if not os.path.exists(excel_path):
            print(f"⚠️  Excel file not found: {excel_path}")
            print("   Skipping database reconstruction")
            print("   You can manually reconstruct later using POST /reconstruct")
        else:
            print(f"📂 Excel file: {excel_path}")
            
            # Perform reconstruction
            reconstructor = get_reconstructor(db_path="./database/chroma_db")
            result = reconstructor.reconstruct_from_excel(
                excel_path=excel_path,
                collection_name="faq_collection",
                backup_existing=True
            )
            
            if result.get("success"):
                items = result.get('items_processed', 0)
                duration = result.get('duration_seconds', 0)
                print(f"✅ Database reconstructed successfully!")
                print(f"   Items processed: {items}")
                print(f"   Duration: {duration:.2f} seconds")
            else:
                error_msg = result.get('error', 'Unknown error')
                print(f"❌ Database reconstruction failed: {error_msg}")
                print("   The server will start, but FAQ queries may not work")
    except Exception as e:
        print(f"❌ Error during database reconstruction: {e}")
        print("   The server will start, but FAQ queries may not work")
        import traceback
        traceback.print_exc()
    
    print("\n" + "=" * 60)
    print("Starting FAQ Cache API Server")
    print("=" * 60)
    
    # Display threshold configuration
    print("\n⚙️  Threshold Configuration:")
    print(f"   Vector Similarity Threshold (query): {VECTOR_SIMILARITY_THRESHOLD}")
    print(f"   Cross Encoder Threshold (query):     {CROSS_ENCODER_THRESHOLD}")
    print(f"   Feedback Save Threshold (question):  {FEEDBACK_SAVE_THRESHOLD}")
    print(f"   Feedback Delete Threshold (Q&A):     {FEEDBACK_DELETE_THRESHOLD}")
    print("   (Can be overridden via environment variables)")
    
    # Run the FastAPI app with uvicorn's built-in reload
    print(f"\n🚀 Starting FAQ Cache API on port {port}...")
    print("🔍 File monitoring enabled (auto-reload)")
    print("📁 Watching: faq_database directory (recursive)")
    print("📋 Monitoring: .py, .xlsx, .xls, .json, .yaml, .yml files")
    print("\n💡 Note: File changes will reload the server but NOT rebuild the database")
    print("   To rebuild database: restart this script or call POST /reconstruct")
    print("\nPress Ctrl+C to stop the server\n")
    
    try:
        uvicorn.run(
            "api.cache_api:app",
            host="0.0.0.0",
            port=port,
            reload=True,  # auto reload enabled
            reload_dirs=["./"],  # monitor current directory and subdirectories
            reload_includes=["*.py", "*.xlsx", "*.xls", "*.json", "*.yaml", "*.yml"],  # monitored file types
            log_level="info",
        )
    except KeyboardInterrupt:
        print("\n\n👋 Shutting down gracefully...")
    finally:
        print("✅ Server stopped successfully")
        print(f"✅ Port {port} released")