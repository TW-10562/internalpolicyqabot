from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class OllamaModelConfig(BaseModel):
    name: str = Field(
        ..., min_length=2, max_length=100, description="Model name in Ollama"
    )
    temperature: Optional[float] = Field(
        default=0.7, ge=0.0, le=1.0, description="Sampling temperature"
    )
    repeat_penalty: Optional[float] = Field(
        default=1.0, ge=0.0, le=2.0, description="Repeat penalty"
    )


class ApacheSolrConfig(BaseModel):
    url: str = Field(..., description="URL of the Apache Solr instance")
    coreName: str = Field(
        ..., min_length=2, max_length=100, description="Core name in Apache Solr"
    )


class MySQLConfig(BaseModel):
    host: str = Field(..., description="MySQL database host")
    port: int = Field(..., ge=0, le=65535, description="MySQL database port")
    user: str = Field(..., description="MySQL database user")
    password: str = Field(..., description="MySQL database password")
    database: str = Field(..., description="MySQL database name")


class OllamaConfig(BaseModel):
    url: list[str] = Field(
        default_factory=list, description="List of URLs for Ollama instances"
    )


class HFModelConfig(BaseModel):
    name: str = Field(
        ..., min_length=2, max_length=100, description="Model name in Hugging Face"
    )
    cacheDir: str = Field(
        default="<PROJECT_ROOT_DIR>/rag/data/model",
        description="Cache directory for the model",
    )


class ModelsConfig(BaseModel):
    chatModel: OllamaModelConfig
    chatTitleGenModel: OllamaModelConfig
    chatKeywordGenModel: OllamaModelConfig
    summaryGenModel: OllamaModelConfig
    translateModel: OllamaModelConfig
    ragEmbeddingModel: HFModelConfig
    ragRerankModel: HFModelConfig


class AviaryBackendConfig(BaseModel):
    host: str = Field(..., description="Host of the Aviary-lite backend instance")
    port: int = Field(
        ..., ge=0, le=65535, description="Port of the Aviary-lite backend instance"
    )
    jwtSecret: str = Field(
        ..., description="JWT secret for the Aviary-lite backend instance"
    )
    jwtRefreshSecret: str = Field(
        ..., description="JWT refresh secret for the Aviary-lite backend instance"
    )
    logTime: str = Field(
        ..., description="Log time for the Aviary-lite backend instance"
    )


class RAGBackendConfig(BaseModel):
    host: str = Field(..., description="Host of the RAG backend instance")
    port: int = Field(
        ..., ge=0, le=65535, description="Port of the RAG backend instance"
    )
    url: str = Field(..., description="URL of the RAG backend instance")


class RAGVectorStoreConfig(BaseModel):
    type: str = Field(..., description="Type of the vector store")
    path: str = Field(..., description="Path to the vector store")


class RAGUploadsConfig(BaseModel):
    rootDir: str = Field(..., description="Root directory for uploads")
    filesDir: str = Field(..., description="Directory for uploaded files")
    maxFileSize: int = Field(..., gt=0, description="Maximum file size for uploads")
    keepExtensions: bool = Field(..., description="Whether to keep file extensions")


class PreProcessSplitByPageConfig(BaseModel):
    separator: Optional[str] = Field(
        default="\n\n", description="Custom separator for text splitting"
    )
    chunkSize: int = Field(default=512, gt=0, description="Size of each text chunk")
    overlap: int = Field(default=128, ge=0, description="Overlap between text chunks")


class PreProcessSplitByArticleConfig(BaseModel):
    footerRatio: float = Field(
        default=0.92, ge=0.0, le=1.0, description="Footer ratio to skip page numbering"
    )
    collectionName: str = Field(
        default="splitByArticleWithHybridSearch",
        description="Collection name for article splitting",
    )
    multiplier: int = Field(
        default=2,
        gt=0,
        description="Multiplier for expanding search results in hybrid mode",
    )


class PreProcessConfig(BaseModel):
    model_config = ConfigDict(extra="allow")
    extensions: Optional[list[str]] = Field(
        default_factory=list, description="File extensions to process"
    )
    splitByPage: PreProcessSplitByPageConfig = Field(
        default=PreProcessSplitByPageConfig(),
        description="Configuration for splitting by page",
    )
    splitByArticle: PreProcessSplitByArticleConfig = Field(
        default=PreProcessSplitByArticleConfig(),
        description="Configuration for splitting by article",
    )


class RAGPreProcessConfig(BaseModel):
    PDF: PreProcessConfig
    DOC: PreProcessConfig
    Default: PreProcessConfig


class RAGHybridSearchBM25Params(BaseModel):
    k1: float = Field(default=1.8, description="BM25 k1 parameter")
    b: float = Field(default=0.75, description="BM25 b parameter")


class RAGHybridSearchConfig(BaseModel):
    vector_only: bool = Field(
        default=False, description="If true, use only vector similarity for search"
    )
    bm25_only: bool = Field(
        default=False, description="If true, use only BM25 relevance for search"
    )
    vector_weight: float = Field(
        default=0.5, description="Weight for vector search score", ge=0.0, le=1.0
    )
    bm25_weight: float = Field(
        default=0.5, description="Weight for BM25 search score", ge=0.0, le=1.0
    )
    bm25_params: RAGHybridSearchBM25Params = Field(
        default=RAGHybridSearchBM25Params(), description="Parameters for BM25"
    )


class RAGRetrievalConfig(BaseModel):
    usingRerank: bool = Field(..., description="Whether to use reranking")
    rerankMaxLength: int = Field(..., gt=0, description="Maximum length for reranker")
    rerankBatchSize: int = Field(
        ..., gt=0, description="Batch size for reranker on CUDA"
    )
    rerankBatchSizeCPU: int = Field(
        ..., gt=0, description="Batch size for reranker on CPU"
    )
    rerankUseCompile: bool = Field(
        ..., description="Whether to use torch.compile for reranker"
    )
    rerankUse8Bit: bool = Field(
        ..., description="Whether to use 8-bit quantization for reranker"
    )
    throwErrorWhenCUDAUnavailable: bool = Field(
        ..., description="Whether to throw an error when CUDA is unavailable"
    )
    topK: int = Field(..., gt=0, description="Number of top results to return")
    HybridSearch: RAGHybridSearchConfig = Field(
        default=RAGHybridSearchConfig(), description="Configuration for hybrid search"
    )
    topKForEachCollection: int = Field(
        ..., gt=0, description="Top K results for each collection"
    )
    usingNeighborChunkAware: bool = Field(
        ..., description="Whether to use neighboring chunk awareness"
    )


class RAGConfig(BaseModel):
    Backend: RAGBackendConfig
    VectorStore: RAGVectorStoreConfig
    Uploads: RAGUploadsConfig
    mode: List[str]
    useFaqCache: bool
    PreProcess: RAGPreProcessConfig
    Retrieval: RAGRetrievalConfig


class ResponseFormatTemplate(BaseModel):
    description: str = Field(..., description="Description of the response format")
    format: str = Field(..., description="Response format")
    example: str = Field(..., description="Example of the response format")


class ResponseFormatPrompt(BaseModel):
    General: ResponseFormatTemplate
    FollowUpQuestion: ResponseFormatTemplate


class AppConfigSchema(BaseModel):
    APP_MODE: Literal["development", "production", "rag-evaluation"]
    ApacheSolr: ApacheSolrConfig
    MySQL: MySQLConfig
    Ollama: OllamaConfig
    Models: ModelsConfig
    Backend: AviaryBackendConfig
    RAG: RAGConfig
    ResponseFormatPrompt: ResponseFormatPrompt
