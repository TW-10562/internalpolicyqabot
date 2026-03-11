import assert from 'node:assert/strict';

import { detectMessageLanguage, resolveRetrievalIndexLanguage } from '@/service/languageRouting';
import { buildHistoryRowsForTurn } from '@/service/historyPersistenceService';
import { buildNotificationInsert } from '@/service/notificationService';

async function run() {
  // 1) language detection (ja/en deterministic)
  assert.equal(detectMessageLanguage('有給休暇はいつ取れますか？'), 'ja');
  assert.equal(detectMessageLanguage('How many leave days do I have?'), 'en');

  // 2) retrieval index routing config parsing
  assert.equal(resolveRetrievalIndexLanguage('ja'), 'ja');
  assert.equal(resolveRetrievalIndexLanguage('en'), 'en');
  assert.equal(resolveRetrievalIndexLanguage('multi'), 'multi');
  assert.equal(resolveRetrievalIndexLanguage('unknown-value'), 'multi');

  // 3) history persistence payload
  const rows = buildHistoryRowsForTurn({
    userId: 101,
    userName: 'alice',
    conversationId: 'conv_abc',
    outputId: 2001,
    userText: '有給休暇は？',
    userLanguage: 'ja',
    workingQuery: 'What is paid leave policy?',
    assistantText: '有給休暇の規定は就業規則第X条です。',
    ragUsed: true,
    sourceIds: ['doc-1', 'doc-2'],
    tokenInput: 111,
    tokenOutput: 222,
    metadata: { route: 'ja->en->ja' },
  });

  assert.equal(rows.userMessage.message_id, '2001:user');
  assert.equal(rows.assistantMessage.message_id, '2001:assistant');
  assert.equal(rows.userMessage.translated_text, 'What is paid leave policy?');
  assert.equal(rows.assistantMessage.model_answer_text, '有給休暇の規定は就業規則第X条です。');

  // 4) notification persistence payload
  const n = buildNotificationInsert({
    userId: 101,
    type: 'chat_reply_ready',
    title: 'Chat response ready',
    body: 'Your answer is available.',
    payload: { conversation_id: 'conv_abc' },
  });

  assert.equal(n.user_id, 101);
  assert.equal(n.type, 'chat_reply_ready');
  assert.equal(n.title, 'Chat response ready');
  assert.equal(n.body, 'Your answer is available.');
  assert.equal(n.is_read, false);

  console.log('PASS: language routing + history/notification payload tests');
}

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});

