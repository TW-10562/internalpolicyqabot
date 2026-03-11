from chromadb import PersistentClient
from config.index import config
from typing import Optional
from langchain_chroma import Chroma

class ChromaRepository:
    def __init__(self):
        self.client = PersistentClient(path=config.RAG.VectorStore.path)

    def create_collection(self, name: str):
        return self.client.create_collection(name=name)

    def get_or_create_collection(self, name: str, metadata: Optional[dict] = None):
        return self.client.get_or_create_collection(name=name, metadata=metadata)

    def get_collection(self, name: str):
        return self.client.get_collection(name=name)

    def delete_collection(self, name: str):
        self.client.delete_collection(name=name)

    def list_collections(self):
        return self.client.list_collections()
    

chroma_db = ChromaRepository()