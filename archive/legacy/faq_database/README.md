# FAQ Database Cache System

A high-performance FAQ caching system built with ChromaDB, sentence transformers, and FastAPI. This system provides intelligent question-answering capabilities through semantic search and cross-encoder reranking.

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [API Endpoints](#api-endpoints)
- [Pipeline Details](#pipeline-details)
- [Project Structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

## 🎯 Overview

The FAQ Database Cache System is designed to provide fast, accurate responses to frequently asked questions by leveraging:

- **Semantic Search**: Uses Japanese sentence-BERT embeddings for understanding question intent
- **Vector Database**: ChromaDB for efficient similarity search
- **Reranking**: Cross-encoder model for precise relevance scoring
- **REST API**: FastAPI-based service for easy integration
- **Auto-Reconstruction**: Automatic database initialization from Excel files

## ✨ Features

- 🚀 **High Performance**: Sub-second query response times
- 🎯 **Semantic Understanding**: Finds relevant FAQs even with different wording
- 🔄 **Auto-Sync**: Automatically reconstructs database from Excel on startup
- 📊 **Dual Scoring**: Vector similarity + cross-encoder reranking
- 🛡️ **Threshold Control**: Configurable confidence thresholds
- 🔍 **Debug Mode**: Detailed logging for development
- 💾 **Persistent Storage**: ChromaDB for data persistence
- 🌐 **REST API**: Easy integration with any application

## 🏗️ Architecture

```
┌─────────────┐
│ User Query  │
└──────┬──────┘
       │
       ▼
┌─────────────────────────────┐
│  FAQ Cache API (FastAPI)    │
│  Port: 8001                  │
└──────────┬──────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  Query Pipeline              │
│  1. Embedding Generation     │
│  2. Vector Search (ANN)      │
│  3. Cross-Encoder Reranking  │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│  ChromaDB                    │
│  - FAQ Questions (vectors)   │
│  - FAQ Answers (metadata)    │
└──────────────────────────────┘
```

### Key Components

1. **Embedding Model**: `sonoisa/sentence-bert-base-ja-mean-tokens-v2`
   - Japanese-optimized sentence transformer
   - 768-dimensional embeddings

2. **Cross-Encoder**: `hotchpotch/japanese-reranker-cross-encoder-large-v1`
   - Precise relevance scoring
   - Final confidence validation

3. **Vector Database**: ChromaDB
   - Efficient similarity search
   - Persistent storage
   - Collection-based organization

## 📦 Installation

### Prerequisites

- Python 3.8+
- pip or conda
- 4GB+ RAM (for models)
- 2GB+ disk space

### Setup

1. **Clone the repository** (if not already done):
```bash
cd /path/to/aviary-lite/faq_database
```

2. **Install dependencies**:
```bash
pip install -r requirements.txt
```

3. **Prepare FAQ data**:
   - Place your FAQ Excel file in `files/` directory
   - Default filename: `faq_10.xlsx`
   - Required columns: `question`, `answer`

4. **First-time setup**:
```bash
python main.py
```

This will:
- Download required models (~2GB)
- Create ChromaDB database
- Load FAQs from Excel
- Start the API server

## ⚙️ Configuration

### Environment Variables

```bash
# API Port (default: 8001)
export FAQ_CACHE_PORT=8001

# Excel File Path (default: files/faq_10.xlsx)
export FAQ_EXCEL_PATH=files/faq_10.xlsx

# Debug Mode (default: False)
export DEBUG=True
```

### Threshold Configuration

Thresholds can be configured per-request or globally:

```python
# In your API requests
{
  "query": "your question",
  "vector_similarity_threshold": 0.3,    # Default: 0.3 (lower = more lenient)
  "cross_encoder_threshold": 0.1         # Default: 0.1 (lower = more lenient)
}
```

**Threshold Guidelines**:
- **Vector Similarity**: 0.0-1.0 (cosine similarity)
  - 0.8+: Very high similarity (same question)
  - 0.5-0.8: Related questions
  - 0.3-0.5: Somewhat related
  - <0.3: Different topics

- **Cross-Encoder**: -1.0 to 1.0 (relevance score)
  - 0.5+: Highly relevant
  - 0.1-0.5: Moderately relevant
  - <0.1: Low relevance

## 🚀 Usage

### Starting the Server

```bash
python main.py
```

Output:
```
============================================================
FAQ Database Initialization
============================================================

🔄 Reconstructing FAQ database from Excel file...
📂 Excel file: files/faq_10.xlsx
✅ Loaded 123 FAQ entries from Excel
🔄 Generating embeddings...
✅ Database reconstructed successfully!
   - Collection: faq_collection
   - Total entries: 123

============================================================
Starting FAQ Cache API Server
============================================================
🚀 Server running at: http://localhost:8001
📚 API Documentation: http://localhost:8001/docs
```

### Basic Query Example

**Python**:
```python
import requests

response = requests.post(
    "http://localhost:8001/query",
    json={
        "query": "有給休暇について教えてください",
        "vector_similarity_threshold": 0.3,
        "cross_encoder_threshold": 0.1
    }
)

result = response.json()

if result["cache_hit"]:
    print(f"Question: {result['question']}")
    print(f"Answer: {result['answer']}")
    print(f"Confidence: {result['confidence']['cross_encoder_score']}")
else:
    print("No matching FAQ found")
```

**cURL**:
```bash
curl -X POST "http://localhost:8001/query" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "有給休暇について教えてください",
    "vector_similarity_threshold": 0.3,
    "cross_encoder_threshold": 0.1
  }'
```

**Response**:
```json
{
  "cache_hit": true,
  "question": "有給休暇の取得方法は？",
  "answer": "有給休暇は勤怠システムから申請できます...",
  "confidence": {
    "vector_similarity": 0.85,
    "cross_encoder_score": 0.92
  },
  "query_time_ms": 145.2
}
```

## 📡 API Endpoints

### Core Endpoints

#### `POST /query` - Query FAQ System
Query the FAQ database with semantic search.

**Request**:
```json
{
  "query": "string (required)",
  "vector_similarity_threshold": 0.3,
  "cross_encoder_threshold": 0.1
}
```

**Response**:
```json
{
  "cache_hit": true,
  "question": "string",
  "answer": "string",
  "confidence": {
    "vector_similarity": 0.85,
    "cross_encoder_score": 0.92
  },
  "query_time_ms": 145.2
}
```

#### `GET /health` - Health Check
Check if the service is running.

**Response**:
```json
{
  "status": "healthy",
  "service": "FAQ Cache API"
}
```

#### `GET /status` - Database Status
Get detailed information about the database.

**Response**:
```json
{
  "status": "ready",
  "database": {
    "path": "./database/chroma_db",
    "exists": true,
    "collections": ["faq_collection"],
    "total_entries": 123
  },
  "models": {
    "embedding_model": "sonoisa/sentence-bert-base-ja-mean-tokens-v2",
    "cross_encoder": "hotchpotch/japanese-reranker-cross-encoder-large-v1",
    "embedding_dimension": 768
  }
}
```

### Management Endpoints

#### `POST /reconstruct` - Rebuild Database
Reconstruct the database from Excel file.

**Request**:
```json
{
  "excel_path": "files/faq_10.xlsx",
  "collection_name": "faq_collection"
}
```

**Response**:
```json
{
  "status": "success",
  "message": "Database reconstructed successfully",
  "entries_processed": 123,
  "collection_name": "faq_collection"
}
```

#### `POST /save` - Add Single FAQ
Add or update a single FAQ entry.

**Request**:
```json
{
  "question": "新しい質問",
  "answer": "新しい回答",
  "collection_name": "faq_collection"
}
```

#### `POST /delete` - Delete FAQ Entry
Delete a FAQ entry by ID.

**Request**:
```json
{
  "entry_id": "unique_id_here",
  "collection_name": "faq_collection"
}
```

#### `POST /reset` - Reset Database
Delete all data and reset the database.

**Request**:
```json
{
  "collection_name": "faq_collection",
  "confirm": true
}
```

### Debug Endpoints

#### `GET /debug/collections` - List Collections
Get all collection names in the database.

#### `GET /debug/collection/{name}` - Collection Details
Get detailed information about a specific collection.

#### `POST /debug/search` - Raw Vector Search
Perform raw vector search without reranking (for debugging).

## 🔬 Pipeline Details

### Query Processing Flow

1. **Input Validation**
   - Validate query string
   - Check thresholds are in valid range

2. **Embedding Generation**
   ```python
   query_embedding = embedding_model.encode(user_query)
   # Output: 768-dimensional vector
   ```

3. **Vector Search (ANN)**
   ```python
   candidates = chromadb.query(
       query_embeddings=[query_embedding],
       n_results=top_k  # Default: 3
   )
   # Returns top-k most similar questions
   ```

4. **Cross-Encoder Reranking**
   ```python
   scores = cross_encoder.predict([
       (user_query, candidate_question)
       for candidate_question in candidates
   ])
   # Returns relevance scores for each candidate
   ```

5. **Threshold Filtering**
   ```python
   if vector_similarity >= threshold_1 and 
      cross_encoder_score >= threshold_2:
       return FAQ_HIT
   else:
       return CACHE_MISS
   ```

### Models Used

| Component | Model | Size | Language |
|-----------|-------|------|----------|
| Embedding | `sonoisa/sentence-bert-base-ja-mean-tokens-v2` | ~500MB | Japanese |
| Reranker | `hotchpotch/japanese-reranker-cross-encoder-large-v1` | ~1.2GB | Japanese |

### Performance Metrics

- **Query Latency**: 100-300ms (depending on hardware)
- **Throughput**: ~10-50 queries/second
- **Memory Usage**: ~3GB (with models loaded)
- **Disk Usage**: ~2GB (models) + database size

## 📁 Project Structure

```
faq_database/
├── README.md                 # This file
├── main.py                   # Application entry point
├── pipeline.py              # Core query pipeline logic
├── requirements.txt         # Python dependencies
│
├── api/                     # FastAPI application
│   ├── __init__.py
│   ├── cache_api.py        # Main API application
│   └── schema.py           # Pydantic models
│
├── database/               # ChromaDB storage
│   ├── __init__.py
│   ├── chroma_repository.py  # Database interface
│   └── chroma_db/          # Persistent database (auto-created)
│
├── services/              # API route handlers
│   ├── __init__.py
│   ├── health.py         # Health check endpoint
│   ├── query.py          # FAQ query endpoint
│   ├── save.py           # Add FAQ endpoint
│   ├── delete.py         # Delete FAQ endpoint
│   ├── status.py         # Status endpoint
│   ├── reset.py          # Reset database endpoint
│   ├── reconstruct.py    # Rebuild database endpoint
│   └── debug.py          # Debug endpoints
│
├── src/                  # Core logic
│   ├── __init__.py
│   ├── ann.py           # ANN search utilities
│   ├── data_loader.py   # Excel data loading
│   ├── embedding.py     # Embedding generation
│   ├── hotchpotch.py    # Model configuration
│   └── db_reconstruction.py  # Database rebuild logic
│
└── files/               # Data files
    └── faq_10.xlsx     # FAQ data (Excel format)
```

## 🛠️ Development

### Running in Development Mode

```bash
# Enable debug logging
export DEBUG=True

# Run with auto-reload
uvicorn api.cache_api:app --reload --port 8001
```

### Running Tests

```bash
# Install test dependencies
pip install pytest pytest-asyncio httpx

# Run tests
pytest tests/
```

### Adding New FAQs

**Option 1: Via Excel File**
1. Edit `files/faq_10.xlsx`
2. Add rows with `question` and `answer` columns
3. Restart server or call `/reconstruct` endpoint

**Option 2: Via API**
```bash
curl -X POST "http://localhost:8001/save" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "新しい質問",
    "answer": "新しい回答"
  }'
```

### Excel File Format

The Excel file should have the following structure:

| question | answer |
|----------|--------|
| 有給休暇の取得方法は？ | 勤怠システムから申請できます... |
| 健康診断はいつですか？ | 年に1回、4月頃に実施されます... |
| ... | ... |

**Requirements**:
- Column names must be exactly `question` and `answer`
- First row must contain headers
- No empty rows between FAQs

## 🐛 Troubleshooting

### Common Issues

#### 1. Models Not Downloading

**Problem**: Models fail to download from Hugging Face.

**Solution**:
```bash
# Set Hugging Face cache directory
export HF_HOME=/path/to/cache

# Or manually download models
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('sonoisa/sentence-bert-base-ja-mean-tokens-v2')
```

#### 2. Port Already in Use

**Problem**: `Address already in use` error.

**Solution**:
```bash
# Find and kill process using port 8001
lsof -ti:8001 | xargs kill -9

# Or use a different port
export FAQ_CACHE_PORT=8002
python main.py
```

#### 3. Out of Memory

**Problem**: System runs out of memory.

**Solution**:
- Reduce batch size in reconstruction
- Use smaller models
- Increase system swap space

#### 4. Excel File Not Found

**Problem**: `Excel file not found` on startup.

**Solution**:
```bash
# Check file path
ls -la files/faq_10.xlsx

# Or set custom path
export FAQ_EXCEL_PATH=/path/to/your/faq.xlsx
python main.py
```

#### 5. Low Accuracy Results

**Problem**: FAQ system returns irrelevant results.

**Solutions**:
- **Increase thresholds**: Set higher values for better precision
  ```json
  {
    "vector_similarity_threshold": 0.5,
    "cross_encoder_threshold": 0.3
  }
  ```
- **Add more FAQs**: Improve coverage with more examples
- **Refine questions**: Make FAQ questions more specific

### Debug Mode

Enable detailed logging:

```bash
export DEBUG=True
python main.py
```

This will show:
- Embedding generation details
- Vector search results
- Cross-encoder scores
- Timing information

### Checking Logs

```bash
# View API logs
tail -f logs/faq_cache.log

# Check ChromaDB logs
tail -f database/chroma_db/chroma.log
```

## 📊 Performance Optimization

### Tips for Better Performance

1. **Use SSD**: Store ChromaDB on SSD for faster access
2. **Increase RAM**: More RAM = faster model loading
3. **Batch Processing**: Process multiple queries in batch
4. **GPU Acceleration**: Use CUDA for faster embeddings
5. **Index Tuning**: Adjust ChromaDB index parameters

### GPU Support

To use GPU acceleration:

```bash
# Install PyTorch with CUDA
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118

# Verify GPU is detected
python -c "import torch; print(torch.cuda.is_available())"
```

## 🔒 Security Considerations

- **API Access**: Add authentication middleware if exposing publicly
- **Rate Limiting**: Implement rate limiting for production use
- **Input Validation**: All inputs are validated via Pydantic models
- **CORS**: Configure CORS settings based on your needs

## 📝 License

This project is part of the Aviary-Lite system. Please refer to the main project license.

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📞 Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues for solutions
- Review the troubleshooting section

## 🎓 Credits

### Models
- **Sentence-BERT**: [sonoisa/sentence-bert-base-ja-mean-tokens-v2](https://huggingface.co/sonoisa/sentence-bert-base-ja-mean-tokens-v2)
- **Cross-Encoder**: [hotchpotch/japanese-reranker-cross-encoder-large-v1](https://huggingface.co/hotchpotch/japanese-reranker-cross-encoder-large-v1)

### Technologies
- **ChromaDB**: Vector database
- **FastAPI**: Web framework
- **Sentence Transformers**: Embedding models
- **Hugging Face**: Model hosting

---

**Version**: 1.0.0  
**Last Updated**: October 2025  
**Maintainer**: Aviary-AI Team
