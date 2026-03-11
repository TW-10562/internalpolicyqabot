#!/usr/bin/env python3
"""
Health check service
"""

from fastapi import APIRouter
from api.schema import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    """Health check endpoint."""
    return HealthResponse()
