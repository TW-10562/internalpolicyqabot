# 翻譯服務環境配置說明

## 前端環境變數配置

在您的 Vue 項目根目錄創建或修改 `.env` 文件：

```bash
# 後端 API 基礎 URL
VITE_APP_BASE_API=http://localhost:3000

# 翻譯服務配置
VITE_TRANSLATE_API_ENDPOINT=/api/translate
VITE_TRANSLATE_TIMEOUT=30000

# 開發環境配置
VITE_APP_ENV=development
```

## 後端環境變數配置

在後端項目根目錄創建 `.env` 文件：

```bash
# 服務器配置
PORT=3000
NODE_ENV=development

# AI 翻譯服務配置
# OpenAI 配置
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-3.5-turbo
OPENAI_MAX_TOKENS=1000
OPENAI_TEMPERATURE=0.3

# Google Translate API 配置（替代方案）
GOOGLE_TRANSLATE_API_KEY=your_google_translate_api_key_here

# 數據庫配置
DATABASE_URL=mongodb://localhost:27017/translation_app
# 或者 PostgreSQL
# DATABASE_URL=postgresql://username:password@localhost:5432/translation_app

# Redis 配置（用於緩存和速率限制）
REDIS_URL=redis://localhost:6379

# JWT 密鑰
JWT_SECRET=your_jwt_secret_here

# 速率限制配置
RATE_LIMIT_WINDOW_MS=900000  # 15分鐘
RATE_LIMIT_MAX_REQUESTS=100  # 15分鐘內最多100次請求
```

## AI 服務配置選項

### 選項 1：OpenAI GPT API

```javascript
// 安裝依賴
npm install openai

// 配置 OpenAI 客戶端
const OpenAI = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
```

### 選項 2：Google Translate API

```javascript
// 安裝依賴
npm install @google-cloud/translate

// 配置 Google Translate 客戶端
const {Translate} = require('@google-cloud/translate').v2;
const translate = new Translate({
  projectId: process.env.GOOGLE_PROJECT_ID,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});
```

### 選項 3：Azure Translator

```javascript
// 安裝依賴
npm install @azure/ai-translation-text

// 配置 Azure Translator 客戶端
const { TextTranslationClient, AzureKeyCredential } = require("@azure/ai-translation-text");
const client = new TextTranslationClient(
  new AzureKeyCredential(process.env.AZURE_TRANSLATOR_KEY),
  process.env.AZURE_TRANSLATOR_ENDPOINT
);
```

## 數據庫模型示例

### MongoDB Schema (Mongoose)

```javascript
const mongoose = require('mongoose');

const translationHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // 可選，支持匿名用戶
  },
  sourceText: {
    type: String,
    required: true,
    maxlength: 2000
  },
  translatedText: {
    type: String,
    required: true,
    maxlength: 2000
  },
  sourceLang: {
    type: String,
    enum: ['ja', 'en'],
    required: true
  },
  targetLang: {
    type: String,
    enum: ['ja', 'en'],
    required: true
  },
  confidence: {
    type: Number,
    min: 0,
    max: 1,
    default: 0.95
  },
  processingTime: {
    type: Number,
    default: 0
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('TranslationHistory', translationHistorySchema);
```

### PostgreSQL Schema

```sql
CREATE TABLE translation_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  source_text TEXT NOT NULL CHECK (char_length(source_text) <= 2000),
  translated_text TEXT NOT NULL CHECK (char_length(translated_text) <= 2000),
  source_lang VARCHAR(2) NOT NULL CHECK (source_lang IN ('ja', 'en')),
  target_lang VARCHAR(2) NOT NULL CHECK (target_lang IN ('ja', 'en')),
  confidence DECIMAL(3,2) DEFAULT 0.95 CHECK (confidence >= 0 AND confidence <= 1),
  processing_time INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 創建索引以提高查詢性能
CREATE INDEX idx_translation_history_user_id ON translation_history(user_id);
CREATE INDEX idx_translation_history_created_at ON translation_history(created_at);
CREATE INDEX idx_translation_history_languages ON translation_history(source_lang, target_lang);
```

## 部署配置

### Docker Compose 示例

```yaml
version: '3.8'
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=mongodb://mongo:27017/translation_app
      - REDIS_URL=redis://redis:6379
    depends_on:
      - mongo
      - redis
    volumes:
      - ./.env:/app/.env

  mongo:
    image: mongo:latest
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db

  redis:
    image: redis:alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  mongo_data:
  redis_data:
```

## 安全配置

### 速率限制中間件

```javascript
const rateLimit = require('express-rate-limit');

const translationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分鐘
  max: 100, // 限制每個IP 15分鐘內最多100次請求
  message: {
    success: false,
    message: '請求過於頻繁，請稍後再試'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 在路由中使用
app.use('/api/translate', translationLimiter);
```

### CORS 配置

```javascript
const cors = require('cors');

const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
```

## 測試配置

### API 測試示例

```bash
# 測試翻譯 API
curl -X POST http://localhost:3000/api/translate \
  -H "Content-Type: application/json" \
  -d '{
    "sourceText": "こんにちは",
    "sourceLang": "ja",
    "targetLang": "en"
  }'

# 測試語言列表 API
curl http://localhost:3000/api/translate/languages
```

## 監控和日誌

### 日誌配置

```javascript
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}
```

這樣配置後，您的翻譯服務就可以正常運行了！

