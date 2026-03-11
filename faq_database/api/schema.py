#!/usr/bin/env python3  
from pydantic import BaseModel, Field
from pydantic.functional_validators import field_validator
from typing import Optional, Dict, Any, List
import os

# Get threshold defaults from environment variables (set in main.py)
_VECTOR_SIMILARITY_THRESHOLD = float(os.environ.get('VECTOR_SIMILARITY_THRESHOLD', 0.8))
_CROSS_ENCODER_THRESHOLD = float(os.environ.get('CROSS_ENCODER_THRESHOLD', 0.5))
_FEEDBACK_SAVE_THRESHOLD = float(os.environ.get('FEEDBACK_SAVE_THRESHOLD', 0.85))
_FEEDBACK_DELETE_THRESHOLD = float(os.environ.get('FEEDBACK_DELETE_THRESHOLD', 0.90))

# Pydantic models for request/response validation
class HealthResponse(BaseModel):
    status: str = "healthy"
    service: str = "FAQ Cache API"


class QueryRequest(BaseModel):
    query: str = Field(..., min_length=1, description="User question in Japanese")
    vector_similarity_threshold: float = Field(default=_VECTOR_SIMILARITY_THRESHOLD, ge=0.0, le=1.0, description="Vector similarity threshold (0-1)")
    cross_encoder_threshold: float = Field(default=_CROSS_ENCODER_THRESHOLD, ge=0.0, le=1.0, description="Cross-encoder score threshold (0-1)")
    
    @field_validator('query')
    @classmethod
    def query_not_empty(cls, v):
        if not v.strip():
            raise ValueError('Query cannot be empty')
        return v.strip()


class ConfidenceInfo(BaseModel):
    vector_similarity: Optional[float] = None
    cross_encoder_score: Optional[float] = None
    vector_distance: Optional[float] = None
    vector_threshold: Optional[float] = None
    cross_encoder_threshold: Optional[float] = None


class QueryResponse(BaseModel):
    cache_hit: bool
    answer: Optional[str] = None
    question: Optional[str] = None
    confidence: Optional[ConfidenceInfo] = None
    message: Optional[str] = None
    reason: Optional[str] = None


class SaveFAQRequest(BaseModel):
    question: str = Field(..., min_length=1, description="FAQ question")
    answer: str = Field(..., min_length=1, description="FAQ answer")
    
    @field_validator('question', 'answer')
    @classmethod
    def fields_not_empty(cls, v):
        if not v.strip():
            raise ValueError('Field cannot be empty')
        return v.strip()


class ExistingFAQ(BaseModel):
    question: str
    answer: str
    similarity: Optional[float] = None


class SaveFAQResponse(BaseModel):
    success: bool
    message: str
    faq_id: Optional[str] = None
    duplicate_detected: bool = False
    similarity_score: Optional[float] = None
    existing_faq: Optional[ExistingFAQ] = None
    similarity_scores: Optional[Dict[str, float]] = None


class DeleteFAQRequest(BaseModel):
    question: str = Field(..., min_length=1, description="Question of FAQ to delete")
    
    @field_validator('question')
    @classmethod
    def question_not_empty(cls, v):
        if not v.strip():
            raise ValueError('Question cannot be empty')
        return v.strip()


class DeletedItem(BaseModel):
    question: str
    answer: str
    similarity: Optional[float] = None


class DeleteFAQResponse(BaseModel):
    success: bool
    message: str
    deleted_count: Optional[int] = None
    remaining_count: Optional[int] = None
    deleted_items: Optional[List[DeletedItem]] = None
    search_criteria: Optional[str] = None
    error: Optional[str] = None


class ResetResponse(BaseModel):
    success: bool
    message: str
    collection_name: Optional[str] = None
    error: Optional[str] = None


class StatsResponse(BaseModel):
    total_faqs: int
    collection_name: str = "faq_collection"
    database_path: str = "./database/chroma_db"


class FAQItem(BaseModel):
    id: str
    question: Optional[str]
    answer_preview: Optional[str]


class ExportResponse(BaseModel):
    count: int
    items: List[FAQItem]


class CleanAnswersResponse(BaseModel):
    success: bool
    message: str
    count: Optional[int] = None
    error: Optional[str] = None


class ReconstructRequest(BaseModel):
    excel_path: str = Field(..., description="Path to Excel file containing FAQ data")
    collection_name: str = Field(default="faq_collection", description="Name of the ChromaDB collection")
    backup_existing: bool = Field(default=True, description="Whether to backup existing database")
    
    @field_validator('excel_path')
    @classmethod
    def excel_path_not_empty(cls, v):
        if not v.strip():
            raise ValueError('Excel path cannot be empty')
        return v.strip()


class ReconstructResponse(BaseModel):
    success: bool
    message: str
    items_processed: Optional[int] = None
    collection_name: Optional[str] = None
    excel_path: Optional[str] = None
    backup_created: Optional[str] = None
    error: Optional[str] = None


class FeedbackRequest(BaseModel):
    cache_signal: int = Field(..., description="Feedback signal: 1 for positive (save), 0 for negative (delete)")
    query: str = Field(..., min_length=1, description="User's query/question")
    answer: Optional[str] = Field(None, description="Answer to the query (required when cache_signal=1)")
    save_threshold: float = Field(default=_FEEDBACK_SAVE_THRESHOLD, ge=0.0, le=1.0, description="Threshold for saving (question similarity)")
    delete_threshold: float = Field(default=_FEEDBACK_DELETE_THRESHOLD, ge=0.0, le=1.0, description="Threshold for deleting (Q&A pair similarity)")
    
    @field_validator('cache_signal')
    @classmethod
    def validate_signal(cls, v):
        if v not in [0, 1]:
            raise ValueError('cache_signal must be 0 or 1')
        return v
    
    @field_validator('query')
    @classmethod
    def query_not_empty(cls, v):
        if not v.strip():
            raise ValueError('Query cannot be empty')
        return v.strip()


class FeedbackResponse(BaseModel):
    success: bool
    message: str
    action_taken: str  # "saved", "deleted", "no_action", "error"
    cache_signal: int
    similar_found: bool = False
    similarity_score: Optional[float] = None
    matched_question: Optional[str] = None
    details: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
