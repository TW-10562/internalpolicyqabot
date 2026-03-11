#!/usr/bin/env python3
"""
Database Reconstruction Module

This module provides functionality to rebuild the FAQ cache database from Excel files.
It handles loading FAQ data, generating embeddings, and storing them in ChromaDB.
"""

import os
import pandas as pd
from typing import List, Tuple, Dict, Any, Optional

# Import our custom modules
from src.data_loader import load_faq_data
from src.embedding import generate_question_embeddings
from database.chroma_repository import ChromaRepository
from src.hotchpotch import default_embedding_model


class DatabaseReconstructor:
    """Handles FAQ database reconstruction from Excel files."""
    
    def __init__(self, db_path: str = "./database/chroma_db"):
        """
        Initialize the database reconstructor.
        
        Args:
            db_path: Path to the ChromaDB database directory
        """
        self.db_path = db_path
        self.repo: Optional[ChromaRepository] = None
    
    def reconstruct_from_excel(
        self, 
        excel_path: str,
        collection_name: str = "faq_collection",
        backup_existing: bool = True
    ) -> Dict[str, Any]:
        """
        Reconstruct the FAQ database from an Excel file.
        
        This function:
        1. Backs up the existing database (if requested)
        2. Loads FAQ data from Excel
        3. Generates embeddings for questions
        4. Stores data in ChromaDB
        
        Args:
            excel_path: Path to the Excel file containing FAQ data
            collection_name: Name of the ChromaDB collection to create/replace
            backup_existing: Whether to backup existing database before reconstruction
        
        Returns:
            Dictionary with reconstruction results including:
            - success: bool
            - message: str
            - items_processed: int
            - collection_name: str
            - excel_path: str
        """
        try:
            # Step 1: Backup existing database if requested
            if backup_existing:
                backup_result = self._backup_database()
                if backup_result:
                    print(f"✅ Backup created: {backup_result}")
            
            # Step 2: Load FAQ data from Excel
            print(f"📂 Loading FAQ data from: {excel_path}")
            
            if not os.path.exists(excel_path):
                return {
                    "success": False,
                    "error": f"Excel file not found: {excel_path}",
                    "message": "Failed to reconstruct database: Excel file not found"
                }
            
            df = load_faq_data(excel_path)
            
            # Extract questions and answers
            questions = df['question'].tolist()
            answers = df['answer'].tolist()
            
            if not questions:
                return {
                    "success": False,
                    "error": "No valid FAQ items found in Excel file",
                    "message": "Failed to reconstruct database: No valid FAQ items"
                }
            
            print(f"📊 Loaded {len(questions)} FAQ items from Excel")
            
            # Step 3: Generate embeddings for questions
            print("🔄 Generating embeddings for questions...")
            embedding_model = default_embedding_model
            embeddings = generate_question_embeddings(questions, embedding_model)
            print(f"✅ Generated {len(embeddings)} embeddings")
            
            # Step 4: Store in ChromaDB
            print(f"💾 Storing data in ChromaDB collection: {collection_name}")
            
            # Initialize repository
            try:
                print(f"🔧 Initializing ChromaRepository at: {self.db_path}")
                self.repo = ChromaRepository(db_path=self.db_path, check_incompatible=True)
                print("✅ ChromaRepository initialized")
            except Exception as init_error:
                # If ChromaDB initialization fails due to compatibility issues,
                # remove the database and retry
                print(f"❌ ChromaDB initialization error: {init_error}")
                print(f"   Error type: {type(init_error).__name__}")
                
                if "vector_index" in str(init_error) or "Invalid parameter" in str(init_error):
                    print("⚠️  Detected incompatible database format")
                    print("🔄 Removing incompatible database and recreating...")
                    
                    import shutil
                    if os.path.exists(self.db_path):
                        # Backup the old database
                        import time
                        backup_path = f"{self.db_path}_backup_{int(time.time())}"
                        shutil.move(self.db_path, backup_path)
                        print(f"📦 Old database backed up to: {backup_path}")
                    
                    # Create fresh database directory
                    os.makedirs(self.db_path, exist_ok=True)
                    
                    # Retry initialization
                    print("🔄 Retrying ChromaRepository initialization...")
                    self.repo = ChromaRepository(db_path=self.db_path, check_incompatible=True)
                    print("✅ ChromaDB reinitialized successfully")
                else:
                    print("❌ Unrecognized error, re-raising...")
                    raise
            
            # Store new data (store_in_chromadb already handles deletion internally)
            try:
                print(f"💾 Calling store_in_chromadb with {len(questions)} items...")
                self.repo.store_in_chromadb(
                    questions=questions,
                    answers=answers,
                    embeddings=embeddings,
                    collection_name=collection_name
                )
                print("✅ Data stored successfully")
            except Exception as store_error:
                print(f"❌ Error during store_in_chromadb: {store_error}")
                import traceback
                print("Full traceback:")
                traceback.print_exc()
                
                # If storage fails due to collection issues, try force-removing the database
                if "vector_index" in str(store_error) or "Invalid parameter" in str(store_error):
                    print("⚠️  Collection storage failed due to incompatibility")
                    print("🔄 Force-removing entire database and recreating...")
                    
                    import shutil
                    # Close any open connections
                    try:
                        del self.repo
                        self.repo = None
                    except:
                        pass
                    
                    if os.path.exists(self.db_path):
                        # Backup the old database
                        import time
                        backup_path = f"{self.db_path}_backup_{int(time.time())}"
                        shutil.move(self.db_path, backup_path)
                        print(f"📦 Old database moved to: {backup_path}")
                    
                    # Create fresh database directory
                    os.makedirs(self.db_path, exist_ok=True)
                    
                    # Reinitialize repository
                    print("🔄 Reinitializing ChromaRepository from scratch...")
                    self.repo = ChromaRepository(db_path=self.db_path, check_incompatible=True)
                    print("✅ ChromaRepository reinitialized")
                    
                    # Retry storage
                    print(f"🔄 Retrying store_in_chromadb...")
                    self.repo.store_in_chromadb(
                        questions=questions,
                        answers=answers,
                        embeddings=embeddings,
                        collection_name=collection_name
                    )
                    print("✅ Data stored successfully after reset")
                else:
                    raise
            
            # Verify storage
            collection = self.repo.get_collection(collection_name)
            actual_count = collection.count()
            
            print(f"✅ Successfully stored {actual_count} items in ChromaDB")
            
            return {
                "success": True,
                "message": f"Successfully reconstructed database with {actual_count} FAQ items",
                "items_processed": actual_count,
                "collection_name": collection_name,
                "excel_path": excel_path,
                "backup_created": backup_result if backup_existing else None
            }
            
        except FileNotFoundError as e:
            error_msg = f"File not found: {str(e)}"
            print(f"❌ {error_msg}")
            return {
                "success": False,
                "error": error_msg,
                "message": "Failed to reconstruct database: File not found"
            }
        
        except ValueError as e:
            error_msg = f"Invalid data format: {str(e)}"
            print(f"❌ {error_msg}")
            return {
                "success": False,
                "error": error_msg,
                "message": "Failed to reconstruct database: Invalid data format"
            }
        
        except Exception as e:
            error_msg = f"Unexpected error during reconstruction: {str(e)}"
            print(f"❌ {error_msg}")
            import traceback
            traceback.print_exc()
            return {
                "success": False,
                "error": error_msg,
                "message": "Failed to reconstruct database: Unexpected error"
            }
    
    def _backup_database(self) -> Optional[str]:
        """
        Create a backup of the existing database.
        
        Returns:
            Path to the backup file if successful, None otherwise
        """
        import shutil
        import time
        
        sqlite_path = os.path.join(self.db_path, 'chroma.sqlite3')
        
        if not os.path.exists(sqlite_path):
            print("ℹ️  No existing database to backup")
            return None
        
        try:
            timestamp = int(time.time())
            backup_path = f"{sqlite_path}.backup.{timestamp}"
            shutil.copy2(sqlite_path, backup_path)
            return backup_path
        except Exception as e:
            print(f"⚠️  Failed to create backup: {e}")
            return None
    
    def get_reconstruction_status(self) -> Dict[str, Any]:
        """
        Get current database status information.
        
        Returns:
            Dictionary with database status including:
            - database_exists: bool
            - collection_count: int (if database exists)
            - database_path: str
        """
        sqlite_path = os.path.join(self.db_path, 'chroma.sqlite3')
        db_exists = os.path.exists(sqlite_path)
        
        result = {
            "database_exists": db_exists,
            "database_path": self.db_path
        }
        
        if db_exists:
            try:
                if self.repo is None:
                    self.repo = ChromaRepository(db_path=self.db_path)
                
                collection = self.repo.get_collection("faq_collection")
                result["collection_count"] = collection.count()
                result["collection_name"] = "faq_collection"
            except Exception as e:
                result["error"] = f"Failed to read collection: {str(e)}"
        
        return result


# Singleton instance for use in API
_reconstructor_instance: Optional[DatabaseReconstructor] = None


def get_reconstructor(db_path: str = "./database/chroma_db") -> DatabaseReconstructor:
    """
    Get or create a DatabaseReconstructor singleton instance.
    
    Args:
        db_path: Path to the ChromaDB database directory
    
    Returns:
        DatabaseReconstructor instance
    """
    global _reconstructor_instance
    
    if _reconstructor_instance is None:
        _reconstructor_instance = DatabaseReconstructor(db_path=db_path)
    
    return _reconstructor_instance
