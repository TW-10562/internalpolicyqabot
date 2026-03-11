import assert from 'node:assert/strict';

import { canonicalizeQuery } from '@/rag/query/canonicalizeQuery';
import { expandQuery } from '@/rag/query/expandQuery';
import { translateQueryForRetrievalDetailed } from '@/utils/query_translation';
import { classifyQueryIntent } from '@/utils/queryIntentClassifier';
import {
  buildEnterpriseRagSystemPrompt,
  buildEvidenceExtractionPrompt,
  buildGroundedAnswerPrompt,
  noEvidenceReply,
} from '@/rag/generation/promptBuilder';
import {
  extractPolicyEvidenceFallback,
  prioritizeFactEvidenceLines,
} from '@/rag/generation/llmGenerator';
import detectLanguage from '@/utils/languageDetector';
import {
  formatSingleLanguageOutput,
  parseDualLanguageOutput,
} from '@/utils/translation';

async function main() {
  assert.equal(detectLanguage('How to apply for overtime?'), 'en');
  assert.equal(detectLanguage('残業申請の方法を教えてください'), 'ja');
  assert.equal(
    classifyQueryIntent('How often are commuting expenses paid to full-time and contract employees?').intent,
    'rag_query',
  );
  assert.equal(classifyQueryIntent('What time is it now?').intent, 'general_chat');

  const enCanonical = canonicalizeQuery('How to apply for overtime?');
  assert.match(enCanonical, /\bapply\b/i);
  assert.match(enCanonical, /\bovertime\b/i);

  const jaCanonical = canonicalizeQuery('残業申請の方法を教えてください');
  assert.match(jaCanonical, /残業/);
  assert.match(jaCanonical, /申請/);

  const jaPartTimeCanonical = canonicalizeQuery('パートタイム社員の通勤費の月額上限はいくらですか。');
  assert.match(jaPartTimeCanonical, /パートタイム/);
  assert.doesNotMatch(jaPartTimeCanonical, /\bぱー\b|\bたいむ\b/);

  const expansion = await expandQuery({
    originalQueryText: 'How to apply for overtime?',
    promptText: 'How to apply for overtime?',
    userLanguage: 'en',
    enableTranslationExpansion: false,
  });
  assert.equal(expansion.queryTranslationApplied, false);
  assert.equal(expansion.queryTranslationStatus, 'none');
  assert.ok(expansion.normalizedQuery.length > 0);
  assert.ok(expansion.canonicalQuery.length > 0);
  assert.ok(expansion.expandedQueries.includes(expansion.canonicalQuery));

  const insuranceQuestion = 'What kind of support is covered by the insurance provided by our company?';
  const insuranceCanonical = canonicalizeQuery(insuranceQuestion);
  const insuranceTranslation = await translateQueryForRetrievalDetailed(insuranceCanonical);
  assert.ok(insuranceTranslation.keywords.some((keyword) => /保険/.test(keyword)));
  assert.ok(insuranceTranslation.keywords.some((keyword) => /支援|サポート/.test(keyword)));

  const insuranceExpansion = await expandQuery({
    originalQueryText: insuranceQuestion,
    promptText: insuranceQuestion,
    userLanguage: 'en',
  });
  assert.equal(insuranceExpansion.queryTranslationApplied, true);
  assert.ok(
    insuranceExpansion.multilingualRetrievalQueries.some((query) => /保険/.test(query)),
  );

  const commuteQuestion = 'How often are commuting expenses paid to full-time and contract employees?';
  const commuteExpansion = await expandQuery({
    originalQueryText: commuteQuestion,
    promptText: commuteQuestion,
    userLanguage: 'en',
  });
  assert.equal(commuteExpansion.queryTranslationApplied, true);
  assert.ok(
    commuteExpansion.multilingualRetrievalQueries.some((query) => /通勤費|交通費|通勤手当/.test(query)),
  );
  assert.ok(
    commuteExpansion.multilingualRetrievalQueries.some((query) => /正社員|契約社員/.test(query)),
  );
  assert.ok(
    commuteExpansion.multilingualRetrievalQueries.some((query) => /通勤費|交通費|通勤手当/.test(query) && /正社員|契約社員/.test(query)),
  );

  const partTimeLimitQuestion = 'What is the monthly upper limit for commuting expenses for part-time staff?';
  const partTimeLimitExpansion = await expandQuery({
    originalQueryText: partTimeLimitQuestion,
    promptText: partTimeLimitQuestion,
    userLanguage: 'en',
  });
  assert.equal(partTimeLimitExpansion.queryTranslationApplied, true);
  assert.ok(
    partTimeLimitExpansion.multilingualRetrievalQueries.some((query) => /月額上限|上限額|限度額|上限/.test(query)),
  );
  assert.ok(
    partTimeLimitExpansion.multilingualRetrievalQueries.some((query) => /パートタイマー|パート社員|短時間勤務/.test(query)),
  );
  assert.ok(
    partTimeLimitExpansion.multilingualRetrievalQueries.some((query) => /通勤費|交通費|通勤手当/.test(query) && /パートタイマー|パート社員|短時間勤務/.test(query)),
  );

  const jaPartTimeLimitQuestion = 'パートタイム社員の通勤費の月額上限はいくらですか。';
  const jaPartTimeLimitExpansion = await expandQuery({
    originalQueryText: jaPartTimeLimitQuestion,
    promptText: jaPartTimeLimitQuestion,
    userLanguage: 'ja',
  });
  assert.match(jaPartTimeLimitExpansion.canonicalQuery, /パートタイム/);
  assert.ok(
    jaPartTimeLimitExpansion.multilingualRetrievalQueries.some((query) => /パートタイマー|パート社員|短時間勤務/.test(query)),
  );
  assert.ok(
    jaPartTimeLimitExpansion.multilingualRetrievalQueries.some((query) => /パートタイマー|パート社員|短時間勤務/.test(query) && /通勤費|月額上限/.test(query)),
  );

  const factContext = [
    '--- Document: 通勤手当支給規程20211001__2112.pdf ---',
    '３．パートタイマー等',
    '（１）入社日より３回目の給与締日までについては、勤務日数に応じて日額を給与支給時に支払う。',
    '（通勤手当の上限）',
    '第９条 いずれの通勤方法においても通勤手当の上限は各号のとおりとする。',
    '（１）定期代については、原則として月額３０,０００円を上限とする。',
    '（２）勤務日数に応じて支給される通勤手当については、原則として日額１,３００円を上限とする。',
  ].join('\n');
  const factEvidence = extractPolicyEvidenceFallback(
    factContext,
    partTimeLimitQuestion,
  );
  assert.ok(factEvidence.some((line) => /30,?000|３０,?０００/.test(line)));
  assert.ok(factEvidence.some((line) => /1,?300|１,?３００/.test(line)));
  const prioritizedFactEvidence = prioritizeFactEvidenceLines(factEvidence, partTimeLimitQuestion, 4);
  assert.ok(prioritizedFactEvidence.some((line) => /30,?000|３０,?０００/.test(line)));

  const housingQuestion = 'Which company handles company housing contracts?';
  const housingExpansion = await expandQuery({
    originalQueryText: housingQuestion,
    promptText: housingQuestion,
    userLanguage: 'en',
  });
  assert.equal(housingExpansion.queryTranslationApplied, true);
  assert.ok(
    housingExpansion.multilingualRetrievalQueries.some((query) => /社宅|社宅契約/.test(query)),
  );

  const creditQuestion =
    'What procedures must be followed before establishing a credit limit when starting accounts receivable transactions with a corporate client?';
  const creditExpansion = await expandQuery({
    originalQueryText: creditQuestion,
    promptText: creditQuestion,
    userLanguage: 'en',
  });
  assert.equal(creditExpansion.queryTranslationApplied, true);
  assert.ok(
    creditExpansion.multilingualRetrievalQueries.some((query) => /与信管理|売掛金|債権管理/.test(query)),
  );

  const systemPrompt = buildEnterpriseRagSystemPrompt('en', true);
  assert.match(systemPrompt, /ONLY the retrieved internal documents/i);
  assert.match(systemPrompt, /Do NOT:/);
  assert.match(systemPrompt, new RegExp(noEvidenceReply('en').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const evidencePrompt = buildEvidenceExtractionPrompt(
    'How to apply for overtime?',
    'Employees must apply overtime via attendance workflow.',
    'Overtime Guide',
    'en',
  );
  assert.match(evidencePrompt, /Overtime Guide/);
  assert.match(evidencePrompt, /NO_EVIDENCE_FOUND/);

  const groundedPrompt = buildGroundedAnswerPrompt(
    'How to apply for overtime?',
    ['Employees must apply overtime via attendance workflow.'],
    'en',
  );
  assert.match(groundedPrompt, /Use only the evidence above/i);
  assert.match(groundedPrompt, /Do not invent any facts/i);

  const formatted = formatSingleLanguageOutput('Approved answer.', 'en', {
    generation_status: 'empty_llm_response',
    used_fallback: true,
  });
  const parsed = parseDualLanguageOutput(formatted);
  assert.equal(parsed.isDualLanguage, false);
  assert.equal(parsed.singleContent, 'Approved answer.');
  assert.equal(parsed.language, 'en');
  assert.equal(parsed.translationPending, true);

  console.log('PASS: focused RAG module unit checks');
}

void main().catch((error) => {
  console.error('[RAG module units] FAILED:', error?.message || error);
  process.exitCode = 1;
});
