import IndexCon from '@/controller';
import { getUserBase } from '@/controller/user';
import {
  clearTranslationHistory,
  getSupportedLanguages,
  getTranslationHistory,
  translateText
} from '@/service/translate';
import Router from 'koa-router';

const router = new Router({ prefix: '/api' });

// Translation-related routing
router.post('/translate', translateText, IndexCon('翻訳が成功しました'));

// Retrieve list of supported languages
router.get('/translate/languages', getSupportedLanguages, IndexCon('言語リストが取得されました'));

// Retrieve translation history (requires user authentication)
router.get('/translate/history', getUserBase, getTranslationHistory, IndexCon('翻訳履歴が取得されました'));

// Clear translation gistory (requires user authentication)
router.delete('/translate/history', getUserBase, clearTranslationHistory, IndexCon('翻訳履歴がクリアされました'));

export default router;

