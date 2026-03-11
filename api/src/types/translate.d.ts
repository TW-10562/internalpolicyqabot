export interface ITranslateRequest {
  sourceText: string;
  sourceLang: 'ja' | 'en';
  targetLang: 'ja' | 'en';
}

export interface ITranslateResponse {
  success: boolean;
  data: {
    sourceText: string;
    translatedText: string;
    sourceLang: 'ja' | 'en';
    targetLang: 'ja' | 'en';
    confidence?: number;
    processingTime?: number;
  };
  message: string;
}

export interface ITranslationHistory {
  id?: number;
  userId?: number;
  sourceText: string;
  translatedText: string;
  sourceLang: 'ja' | 'en';
  targetLang: 'ja' | 'en';
  confidence?: number;
  processingTime?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ITranslateHistoryQuery {
  userId?: number;
  page?: number;
  size?: number;
  sourceLang?: 'ja' | 'en';
  targetLang?: 'ja' | 'en';
}

export interface ITranslateHistoryResponse {
  items: ITranslationHistory[];
  total: number;
  hasMore: boolean;
  pagination: {
    page: number;
    size: number;
    total: number;
  };
}

export interface ITranslateError {
  code: string;
  message: string;
  details?: any;
}

