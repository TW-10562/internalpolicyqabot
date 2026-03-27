from chromadb import PersistentClient
import os
import sqlite3
import json
import time
import shutil

class ChromaRepository:
    def __init__(self, db_path="./database/chroma_db", check_incompatible=False):
        self.db_path = db_path
        # create directory if not exists
        os.makedirs(db_path, exist_ok=True)
        
        # Check for incompatible database before repair attempts (only if requested)
        if check_incompatible and self._has_incompatible_config():
            print("⚠️  Detected incompatible database configuration (vector_index parameter)")
            print("🔄 Removing incompatible database to allow clean recreation...")
            sqlite_path = os.path.join(self.db_path, "chroma.sqlite3")
            if os.path.exists(sqlite_path):
                backup = f"{sqlite_path}.incompatible_backup.{int(time.time())}"
                shutil.copy2(sqlite_path, backup)
                os.remove(sqlite_path)
                print(f"📦 Backed up incompatible DB to: {backup}")
        
        # Try to ensure DB integrity before creating the client. Missing
        # or malformed collection config JSON (missing '_type') is a
        # common cause of PersistentClient failures; repair if possible.
        try:
            self._ensure_db_integrity()
        except Exception as e:
            # Best-effort - log and continue to allow PersistentClient
            # to attempt to initialize (it may recreate files).
            print(f"Warning: failed to ensure DB integrity: {e}")

        # Initialize the persistent client; if it fails due to config
        # corruption, attempt a simple repair/backup and retry once.
        try:
            self.client = PersistentClient(path=db_path)
        except Exception as e:
            err_str = str(e)
            print(f"PersistentClient init failed: {err_str}")
            # If the error looks like the common '_type' config problem,
            # try a backup+repair strategy and retry
            if "_type" in err_str or "CollectionConfigurationInternal" in err_str:
                try:
                    sqlite_path = os.path.join(self.db_path, "chroma.sqlite3")
                    if os.path.exists(sqlite_path):
                        backup = f"{sqlite_path}.backup.{int(time.time())}"
                        shutil.copy2(sqlite_path, backup)
                        print(f"Backed up corrupted DB to: {backup}")
                        # Remove sqlite file to allow Chroma to recreate clean DB
                        os.remove(sqlite_path)
                        print("Removed corrupted sqlite file to allow rebuild")
                    # Retry client init
                    self.client = PersistentClient(path=db_path)
                except Exception as retry_e:
                    print(f"Retry after repair failed: {retry_e}")
                    # re-raise to let callers handle
                    raise
            else:
                # re-raise unknown errors
                raise

    def create_collection(self, name: str):
        return self.client.create_collection(name=name)

    def get_or_create_collection(self, name: str):
        return self.client.get_or_create_collection(name=name)

    def get_collection(self, name: str):
        return self.client.get_collection(name=name)

    def delete_collection(self, name: str):
        self.client.delete_collection(name=name)

    def store_in_chromadb(
        self,
        questions,
        answers,
        embeddings,
        collection_name: str = "faq_collection",
    ):
        """
        Store question embeddings in ChromaDB under this repository.

        Args:
            questions: list of question strings
            answers: list of answer strings
            embeddings: list of embedding vectors
            collection_name: name of the collection to create/store

        Returns:
            self
        """
        # Try to delete existing collection if it exists
        try:
            self.delete_collection(collection_name)
        except Exception:
            # ignore if it doesn't exist
            pass

        # Create new collection
        collection = self.create_collection(collection_name)

        # Prepare data
        ids = [f"faq_{i}" for i in range(len(questions))]
        metadatas = [{"question": q, "answer": a} for q, a in zip(questions, answers)]
        documents = questions

        # Add to collection
        collection.add(
            ids=ids,
            embeddings=embeddings,
            metadatas=metadatas,
            documents=documents,
        )

        return self

    def _get_collection_dimension(self, name: str):
        """Return the stored dimension for a collection if present in sqlite metadata."""
        sqlite_path = os.path.join(self.db_path, "chroma.sqlite3")
        if not os.path.exists(sqlite_path):
            return None
        try:
            conn = sqlite3.connect(sqlite_path)
            cursor = conn.cursor()
            cursor.execute('SELECT dimension FROM collections WHERE name = ?', (name,))
            row = cursor.fetchone()
            conn.close()
            if row and row[0] is not None:
                return int(row[0])
        except Exception:
            return None
        return None

    def _ensure_db_integrity(self):
        """Repair simple config JSON problems in an existing chroma.sqlite3.

        This targets the common problem where collection.config_json_str is
        missing a top-level '_type' or the nested 'hnsw_configuration' lacks
        its '_type'. We attempt to fix in-place; if that fails we leave the
        sqlite file untouched so the caller can choose a backup+recreate.
        """
        sqlite_path = os.path.join(self.db_path, "chroma.sqlite3")
        if not os.path.exists(sqlite_path):
            return

        try:
            conn = sqlite3.connect(sqlite_path)
            cursor = conn.cursor()

            # Quick existence check
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='collections'")
            if not cursor.fetchone():
                conn.close()
                return

            # Standard minimal config template
            standard_config = {
                'hnsw_configuration': {
                    'space': 'l2',
                    'ef_construction': 100,
                    'ef_search': 100,
                    'num_threads': 1,
                    'M': 16,
                    'resize_factor': 1.2,
                    'batch_size': 100,
                    'sync_threshold': 1000,
                    '_type': 'HNSWConfigurationInternal'
                },
                '_type': 'CollectionConfigurationInternal'
            }

            cursor.execute('SELECT id, name, config_json_str FROM collections')
            rows = cursor.fetchall()
            updates = 0

            for id, name, config_str in rows:
                needs_fix = False
                new_config = None

                if not config_str:
                    needs_fix = True
                    new_config = standard_config.copy()
                else:
                    try:
                        cfg = json.loads(config_str)
                        if not isinstance(cfg, dict):
                            needs_fix = True
                            new_config = standard_config.copy()
                        else:
                            if '_type' not in cfg:
                                cfg['_type'] = 'CollectionConfigurationInternal'
                                needs_fix = True

                            hnsw = cfg.get('hnsw_configuration')
                            if not isinstance(hnsw, dict):
                                cfg['hnsw_configuration'] = standard_config['hnsw_configuration'].copy()
                                needs_fix = True
                            else:
                                if '_type' not in hnsw:
                                    cfg['hnsw_configuration']['_type'] = 'HNSWConfigurationInternal'
                                    needs_fix = True

                            if needs_fix:
                                new_config = cfg
                    except Exception:
                        needs_fix = True
                        new_config = standard_config.copy()

                if needs_fix and new_config is not None:
                    try:
                        new_str = json.dumps(new_config)
                        cursor.execute('UPDATE collections SET config_json_str = ? WHERE id = ?', (new_str, id))
                        updates += 1
                    except Exception as e:
                        print(f"Warning: failed to update config for collection {name}: {e}")

            if updates > 0:
                conn.commit()
                print(f"Repaired {updates} collection config(s) in chroma.sqlite3")

            conn.close()
        except Exception as e:
            print(f"Error while attempting DB config repair: {e}")
            # Bubble up so caller can take more aggressive action if desired
            raise

    def _has_incompatible_config(self):
        """Check if the database has incompatible configuration (e.g., vector_index parameter)."""
        sqlite_path = os.path.join(self.db_path, "chroma.sqlite3")
        if not os.path.exists(sqlite_path):
            return False
        
        try:
            conn = sqlite3.connect(sqlite_path)
            cursor = conn.cursor()
            
            # Check if collections table exists
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='collections'")
            if not cursor.fetchone():
                conn.close()
                return False
            
            # Check for incompatible parameters in any collection
            cursor.execute('SELECT config_json_str FROM collections')
            rows = cursor.fetchall()
            
            for (config_str,) in rows:
                if config_str and 'vector_index' in config_str:
                    conn.close()
                    return True
            
            conn.close()
            return False
        except Exception as e:
            print(f"Warning: Error checking for incompatible config: {e}")
            return False

    def safe_add(self, collection_name: str, documents, metadatas, ids, embeddings=None):
        """Add items to collection with a guard ensuring embedding dimensionality matches.

        If the collection exists and has a recorded dimension different from the provided
        embeddings, raise a ValueError to avoid corrupting the collection.
        """
        collection = self.get_or_create_collection(collection_name)

        # If embeddings present, check dimensionality
        if embeddings and len(embeddings) > 0:
            emb_dim = len(embeddings[0])
            existing_dim = self._get_collection_dimension(collection_name)
            if existing_dim is not None and existing_dim != emb_dim:
                raise ValueError(f"Embedding dimension mismatch: collection={existing_dim}, provided={emb_dim}")

        # Delegate to collection.add
        if embeddings is not None:
            collection.add(ids=ids, embeddings=embeddings, metadatas=metadatas, documents=documents)
        else:
            collection.add(ids=ids, metadatas=metadatas, documents=documents)

        return collection