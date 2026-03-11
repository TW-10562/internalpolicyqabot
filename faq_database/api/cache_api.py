#!/usr/bin/env python3
"""
FAQ Cache API Service (FastAPI)

This service provides a REST API endpoint to query the FAQ cache (ChromaDB).
It integrates with the existing pipeline to provide fast FAQ lookups.

Refactored version with modular services.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os
import sys
from contextlib import asynccontextmanager

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import service routers
from services import health, query, save, delete, status, reset, reconstruct, debug, feedback

# Import the initialize function from query service (as it's shared)
from services.query import initialize_faq_system


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle manager for FastAPI app - runs on startup and shutdown."""
    # Startup
    print("=== FAQ Cache API Server (FastAPI) ===")
    print("Starting FAQ Cache API service...")
    
    # Note: Database reconstruction is now handled in main.py before server starts
    # This lifespan only initializes the FAQ query system
    
    # Try to initialize FAQ system
    print("\n🔧 Initializing FAQ system...")
    if initialize_faq_system(silent_fail=True):
        print("✅ FAQ system ready")
    else:
        print("⚠️  FAQ system not initialized")
        print("   You can manually reconstruct using POST /reconstruct")
    
    port = int(os.environ.get('FAQ_CACHE_PORT', 8001))
    print(f"\n🚀 Server starting on port {port}")
    print(f"📍 Health check: http://localhost:{port}/health")
    print(f"📍 Query endpoint: http://localhost:{port}/query")
    print(f"📍 API docs: http://localhost:{port}/docs")
    print(f"📍 Stats endpoint: http://localhost:{port}/stats")
    print(f"📍 Reconstruct: http://localhost:{port}/reconstruct")
    
    yield
    
    # Shutdown
    print("\n👋 Shutting down FAQ Cache API service...")


# Create FastAPI app
app = FastAPI(
    title="FAQ Cache API",
    description="REST API for querying FAQ cache powered by ChromaDB and semantic search",
    version="2.0.0",
    lifespan=lifespan
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include all service routers
app.include_router(health.router)
app.include_router(query.router)
app.include_router(save.router)
app.include_router(delete.router)
app.include_router(status.router)
app.include_router(reset.router)
app.include_router(reconstruct.router)
app.include_router(debug.router)
app.include_router(feedback.router)
