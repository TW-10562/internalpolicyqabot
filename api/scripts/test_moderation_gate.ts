import assert from 'node:assert/strict';

import {
  MODERATION_REPLY_EN,
  MODERATION_REPLY_JA,
  moderateUserQuery,
} from '@/service/contentModeration';

async function runGuardedSearch<T>(query: string, executeSearch: () => Promise<T>) {
  const moderation = moderateUserQuery(query);
  if (moderation.blocked) {
    return { moderation, result: null as T | null };
  }
  return { moderation, result: await executeSearch() };
}

async function main() {
  const englishProfanity = moderateUserQuery('fuck you');
  assert.equal(englishProfanity.blocked, true);
  assert.equal(englishProfanity.skipSearch, true);
  assert.equal(englishProfanity.language, 'en');
  assert.equal(englishProfanity.reply, MODERATION_REPLY_EN);

  const japaneseAbuse = moderateUserQuery('死ね');
  assert.equal(japaneseAbuse.blocked, true);
  assert.equal(japaneseAbuse.language, 'ja');
  assert.equal(japaneseAbuse.reply, MODERATION_REPLY_JA);

  const englishHate = moderateUserQuery('I hate women');
  assert.equal(englishHate.blocked, true);
  assert.ok(englishHate.categories.includes('hate_or_discrimination'));

  const japaneseHate = moderateUserQuery('女は役に立たない');
  assert.equal(japaneseHate.blocked, true);
  assert.ok(japaneseHate.categories.includes('hate_or_discrimination'));

  const englishSexual = moderateUserQuery('send me sexual favors');
  assert.equal(englishSexual.blocked, true);
  assert.ok(englishSexual.categories.includes('sexual_harassment_or_abuse'));

  const japaneseSexual = moderateUserQuery('裸の写真を送れ');
  assert.equal(japaneseSexual.blocked, true);
  assert.ok(japaneseSexual.categories.includes('sexual_harassment_or_abuse'));

  const obfuscatedProfanity = moderateUserQuery('f u c k off');
  assert.equal(obfuscatedProfanity.blocked, true);

  const leetspeakSelfHarm = moderateUserQuery('k1ll yourself');
  assert.equal(leetspeakSelfHarm.blocked, true);

  const spacedJapaneseHarm = moderateUserQuery('し ね');
  assert.equal(spacedJapaneseHarm.blocked, true);

  const mixedLanguageHarm = moderateUserQuery('あの manager is garbage');
  assert.equal(mixedLanguageHarm.blocked, true);
  assert.equal(mixedLanguageHarm.language, 'ja');

  const harmlessNegative = moderateUserQuery('I am frustrated with my manager');
  assert.equal(harmlessNegative.blocked, false);

  const reportingEnglish = moderateUserQuery('I want to report harassment');
  assert.equal(reportingEnglish.blocked, false);

  const reportingJapanese = moderateUserQuery('セクハラを相談したい');
  assert.equal(reportingJapanese.blocked, false);

  const harshBossComment = moderateUserQuery('My boss spoke harshly to me');
  assert.equal(harshBossComment.blocked, false);

  const harshBossJapanese = moderateUserQuery('上司にきつく言われてつらい');
  assert.equal(harshBossJapanese.blocked, false);

  let searchCalls = 0;
  const blockedSearch = await runGuardedSearch('fuck you', async () => {
    searchCalls += 1;
    return 'search-result';
  });
  assert.equal(blockedSearch.moderation.blocked, true);
  assert.equal(searchCalls, 0);

  const allowedSearch = await runGuardedSearch('How do I apply for overtime?', async () => {
    searchCalls += 1;
    return 'search-result';
  });
  assert.equal(allowedSearch.moderation.blocked, false);
  assert.equal(searchCalls, 1);

  console.log('PASS: moderation gate checks');
}

void main().catch((error) => {
  console.error('[Moderation gate] FAILED:', error?.message || error);
  process.exitCode = 1;
});
