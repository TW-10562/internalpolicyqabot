import { ITranslateRequest, ITranslateResponse, ITranslationHistory, ITranslateHistoryQuery, ITranslateHistoryResponse } from '@/types';
import { Context } from 'koa';

// 模擬 AI 翻譯服務（實際使用時應替換為真實的 AI API）
class AITranslationService {
  private static instance: AITranslationService;
  
  private constructor() {}
  
  public static getInstance(): AITranslationService {
    if (!AITranslationService.instance) {
      AITranslationService.instance = new AITranslationService();
    }
    return AITranslationService.instance;
  }

  /**
   * 使用 AI 進行翻譯
   */
  public async translate(text: string, sourceLanguage: 'ja' | 'en', targetLanguage: 'ja' | 'en'): Promise<{ translatedText: string; confidence: number; processingTime: number }> {
    const startTime = Date.now();
    
    try {
      // 這裡應該調用實際的 AI 翻譯服務
      // 例如：OpenAI GPT、Google Translate API、Azure Translator 等
      
      // 模擬翻譯邏輯（實際使用時應替換）
      let translatedText = '';
      
      if (sourceLanguage === 'ja' && targetLanguage === 'en') {
        // 日文到英文的簡單翻譯示例
        translatedText = await this.translateJapaneseToEnglish(text);
      } else if (sourceLanguage === 'en' && targetLanguage === 'ja') {
        // 英文到日文的簡單翻譯示例
        translatedText = await this.translateEnglishToJapanese(text);
      } else {
        throw new Error('不支援的語言組合');
      }
      
      const processingTime = Date.now() - startTime;
      
      return {
        translatedText,
        confidence: 0.95, // 模擬置信度
        processingTime
      };
      
    } catch (error) {
      throw new Error(`AI 翻譯服務錯誤: ${error.message}`);
    }
  }

  /**
   * 日文到英文翻譯（模擬）
   */
  private async translateJapaneseToEnglish(text: string): Promise<string> {
    // 這裡應該調用真實的 AI 翻譯 API
    // 例如 OpenAI GPT API
    
    // 模擬 API 調用延遲
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 簡單的日文翻譯示例（實際使用時應替換為 AI 翻譯）
    const translations: { [key: string]: string } = {
      'こんにちは': 'Hello',
      'ありがとう': 'Thank you',
      'おはよう': 'Good morning',
      'さようなら': 'Goodbye',
      'はい': 'Yes',
      'いいえ': 'No',
      'お疲れ様': 'Good work',
      '失礼します': 'Excuse me'
    };
    
    // 如果找到直接翻譯，返回結果
    if (translations[text]) {
      return translations[text];
    }
    
    // 模擬 AI 翻譯結果
    return `[AI Translation EN]: ${text}`;
  }

  /**
   * 英文到日文翻譯（模擬）
   */
  private async translateEnglishToJapanese(text: string): Promise<string> {
    // 這裡應該調用真實的 AI 翻譯 API
    
    // 模擬 API 調用延遲
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 簡單的英文翻譯示例（實際使用時應替換為 AI 翻譯）
    const translations: { [key: string]: string } = {
      'hello': 'こんにちは',
      'thank you': 'ありがとう',
      'good morning': 'おはよう',
      'goodbye': 'さようなら',
      'yes': 'はい',
      'no': 'いいえ',
      'good work': 'お疲れ様',
      'excuse me': '失礼します'
    };
    
    // 如果找到直接翻譯，返回結果
    if (translations[text.toLowerCase()]) {
      return translations[text.toLowerCase()];
    }
    
    // 模擬 AI 翻譯結果
    return `[AI 翻訳 JA]: ${text}`;
  }
}

// 翻譯歷史記錄管理
class TranslationHistoryManager {
  private static instance: TranslationHistoryManager;
  private history: ITranslationHistory[] = [];
  
  private constructor() {}
  
  public static getInstance(): TranslationHistoryManager {
    if (!TranslationHistoryManager.instance) {
      TranslationHistoryManager.instance = new TranslationHistoryManager();
    }
    return TranslationHistoryManager.instance;
  }

  /**
   * 保存翻譯歷史
   */
  public async saveHistory(historyData: Omit<ITranslationHistory, 'id' | 'createdAt' | 'updatedAt'>): Promise<ITranslationHistory> {
    const newHistory: ITranslationHistory = {
      ...historyData,
      id: this.history.length + 1,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    this.history.push(newHistory);
    
    // 限制歷史記錄數量（最多保存1000條）
    if (this.history.length > 1000) {
      this.history = this.history.slice(-1000);
    }
    
    return newHistory;
  }

  /**
   * 獲取翻譯歷史
   */
  public async getHistory(query: ITranslateHistoryQuery): Promise<ITranslateHistoryResponse> {
    let filteredHistory = [...this.history];
    
    // 按用戶ID過濾
    if (query.userId) {
      filteredHistory = filteredHistory.filter(h => h.userId === query.userId);
    }
    
    // 按語言過濾
    if (query.sourceLang) {
      filteredHistory = filteredHistory.filter(h => h.sourceLang === query.sourceLang);
    }
    
    if (query.targetLang) {
      filteredHistory = filteredHistory.filter(h => h.targetLang === query.targetLang);
    }
    
    // 按時間排序（最新的在前）
    filteredHistory.sort((a, b) => 
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );
    
    const page = query.page || 1;
    const size = query.size || 20;
    const skip = (page - 1) * size;
    
    const items = filteredHistory.slice(skip, skip + size);
    const total = filteredHistory.length;
    const hasMore = skip + size < total;
    
    return {
      items,
      total,
      hasMore,
      pagination: {
        page,
        size,
        total
      }
    };
  }

  /**
   * 清空翻譯歷史
   */
  public async clearHistory(userId?: number): Promise<void> {
    if (userId) {
      this.history = this.history.filter(h => h.userId !== userId);
    } else {
      this.history = [];
    }
  }
}

/**
 * 主要翻譯函數
 */
export async function translateText(ctx: any, next: () => Promise<void>): Promise<void> {
  try {
    const { sourceText, sourceLang, targetLang } = ctx.request.body as ITranslateRequest;
    
    // 驗證請求參數
    if (!sourceText || sourceText.trim().length === 0) {
      ctx.app.emit('error', {
        code: '400',
        message: '翻訳テキストが空です',
      }, ctx);
      return;
    }
    
    if (sourceText.length > 2000) {
      ctx.app.emit('error', {
        code: '400',
        message: '翻訳テキストは2000文字以内で入力してください',
      }, ctx);
      return;
    }
    
    if (!['ja', 'en'].includes(sourceLang) || !['ja', 'en'].includes(targetLang)) {
      ctx.app.emit('error', {
        code: '400',
        message: 'サポートされていない言語コードです。日本語(ja)と英語(en)のみ対応しています',
      }, ctx);
      return;
    }
    
    if (sourceLang === targetLang) {
      ctx.app.emit('error', {
        code: '400',
        message: 'ソース言語とターゲット言語は異なる必要があります',
      }, ctx);
      return;
    }
    
    // 調用 AI 翻譯服務
    const aiService = AITranslationService.getInstance();
    const translationResult = await aiService.translate(
      sourceText.trim(),
      sourceLang,
      targetLang
    );
    
    // 保存翻譯歷史
    const historyManager = TranslationHistoryManager.getInstance();
    const currentUserId = ctx.state.user?.userId;
    
    await historyManager.saveHistory({
      userId: currentUserId,
      sourceText: sourceText.trim(),
      translatedText: translationResult.translatedText,
      sourceLang,
      targetLang,
      confidence: translationResult.confidence,
      processingTime: translationResult.processingTime
    });
    
    // 設置響應數據
    const response: ITranslateResponse = {
      success: true,
      data: {
        sourceText: sourceText.trim(),
        translatedText: translationResult.translatedText,
        sourceLang,
        targetLang,
        confidence: translationResult.confidence,
        processingTime: translationResult.processingTime
      },
      message: '翻訳が完了しました'
    };
    
    ctx.state.formatData = response;
    await next();
    
  } catch (error) {
    console.error('翻訳サービスエラー:', error);
    
    let errorMessage = '翻訳中にエラーが発生しました';
    let errorCode = '500';
    
    if (error.message.includes('AI 翻譯服務錯誤')) {
      errorMessage = 'AI翻訳サービスが一時的に利用できません。しばらく待ってから再試行してください';
      errorCode = '503';
    } else if (error.message.includes('不支援的語言組合')) {
      errorMessage = 'サポートされていない言語の組み合わせです';
      errorCode = '400';
    }
    
    ctx.app.emit('error', {
      code: errorCode,
      message: errorMessage,
    }, ctx);
  }
}

/**
 * 獲取翻譯歷史
 */
export async function getTranslationHistory(ctx: Context, next: () => Promise<void>): Promise<void> {
  try {
    const { page = 1, size = 20, sourceLang, targetLang } = ctx.query as any;
    const currentUserId = ctx.state.user?.userId;
    
    const historyManager = TranslationHistoryManager.getInstance();
    const history = await historyManager.getHistory({
      userId: currentUserId,
      page: parseInt(page),
      size: parseInt(size),
      sourceLang,
      targetLang
    });
    
    ctx.state.formatData = history;
    await next();
    
  } catch (error) {
    console.error('翻訳履歴取得エラー:', error);
    ctx.app.emit('error', {
      code: '500',
      message: '翻訳履歴の取得に失敗しました',
    }, ctx);
  }
}

/**
 * 清空翻譯歷史
 */
export async function clearTranslationHistory(ctx: Context, next: () => Promise<void>): Promise<void> {
  try {
    const currentUserId = ctx.state.user?.userId;
    
    const historyManager = TranslationHistoryManager.getInstance();
    await historyManager.clearHistory(currentUserId);
    
    ctx.state.formatData = { success: true, message: '翻訳履歴がクリアされました' };
    await next();
    
  } catch (error) {
    console.error('翻訳履歴クリアエラー:', error);
    ctx.app.emit('error', {
      code: '500',
      message: '翻訳履歴のクリアに失敗しました',
    }, ctx);
  }
}

/**
 * 獲取支援的語言列表
 */
export async function getSupportedLanguages(ctx: Context, next: () => Promise<void>): Promise<void> {
  try {
    const languages = [
      { code: 'ja', name: '日本語', nativeName: '日本語' },
      { code: 'en', name: 'English', nativeName: 'English' }
    ];
    
    ctx.state.formatData = {
      languages,
      defaultSource: 'ja',
      defaultTarget: 'en'
    };
    
    await next();
    
  } catch (error) {
    console.error('言語リスト取得エラー:', error);
    ctx.app.emit('error', {
      code: '500',
      message: '言語リストの取得に失敗しました',
    }, ctx);
  }
}