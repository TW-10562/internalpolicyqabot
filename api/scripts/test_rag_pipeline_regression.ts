<<<<<<< ours
import {
  buildFallbackWildcardQuery,
  rewriteRagQueryWithSynonyms,
  routeStrongIntent,
} from '@/service/ragQueryHeuristics';
import { runBoundedSolrRetrieval } from '@/service/ragRetrievalPlanner';

type MockDoc = {
  id: string;
  bucket: 'HR' | 'GA' | 'POLICY';
  title: string;
  body: string;
};

const docs: MockDoc[] = [
  {
    id: 'hr_overtime_doc',
    bucket: 'HR',
    title: 'HR Overtime Application Procedure',
    body: 'Employees must apply overtime via attendance workflow. 残業申請の手順を定める。',
  },
  {
    id: 'ga_commute_doc',
    bucket: 'GA',
    title: 'GA Commuting Allowance Manual',
    body: 'Commuter pass and transport allowance application procedure.',
  },
  {
    id: 'probation_policy_doc',
    bucket: 'POLICY',
    title: 'Probation Period Policy',
    body: 'The company probation period policy and 試用期間 rules.',
  },
];

const tokenize = (text: string): string[] =>
  String(text || '')
    .toLowerCase()
    .split(/\s+/)
    .map((v) => v.trim())
    .filter(Boolean);

const scoreDoc = (query: string, doc: MockDoc): number => {
  const qTokens = tokenize(query);
  const hay = `${doc.title} ${doc.body}`.toLowerCase();
  let score = 0;
  for (const token of qTokens) {
    if (token.length < 2) continue;
    if (hay.includes(token.replace(/\*+$/, ''))) score += 1;
  }
  return score;
};

const resolveBucket = (intentLabel: string): MockDoc['bucket'] | 'ANY' => {
  if (intentLabel === 'HR_PAYROLL_ATTENDANCE') return 'HR';
  if (intentLabel === 'GENERAL_POLICY') return 'POLICY';
  return 'ANY';
};

const hasExplicitProcedureCue = (query: string): boolean => {
  const text = String(query || '').trim();
  if (!text) return false;
  const strongProcedureCue =
    /\b(how\s+to|where\s+to|steps?|step\s*\d+|procedure|procedures|process|workflow|apply|application|request|report|submit|approval|approve|form|portal)\b/i.test(text) ||
    /(手順|申請|申込|報告|提出|承認|流れ|進め方|対応手順|フォーム|ポータル)/.test(text);
  const weakHowCue =
    /\b(how|where)\b/i.test(text) ||
    /(どうすれば|どのように|方法)/.test(text);
  const managementSummaryCue =
    /\b(manage|managed|management|policy|policies|purpose|defined|classification)\b/i.test(text) ||
    /(管理(?:され|する|方法)?|方針|規程|目的|定義|区分)/.test(text);
  if (strongProcedureCue) return true;
  if (managementSummaryCue && !strongProcedureCue) return false;
  return weakHowCue;
};

const buildAnswerStyleProbeText = (originalQuery: string, retrievalQuery: string): string =>
  [String(originalQuery || '').trim(), String(retrievalQuery || '').trim()]
    .filter(Boolean)
    .join(' ');

const pickTopDoc = (query: string): MockDoc | null => {
  const rewritten = rewriteRagQueryWithSynonyms(query);
  const intent = routeStrongIntent(rewritten);
  const bucket = resolveBucket(intent.label);
  const fallback = buildFallbackWildcardQuery(rewritten, intent.label as any);
  const candidates = bucket === 'ANY' ? docs : docs.filter((d) => d.bucket === bucket);
  const ranked = candidates
    .map((doc) => ({ doc, score: Math.max(scoreDoc(rewritten, doc), scoreDoc(fallback, doc)) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].doc : null;
};

const assertDoc = (query: string, expectedDocId: string): void => {
  const doc = pickTopDoc(query);
  if (!doc || doc.id !== expectedDocId) {
    throw new Error(`Query "${query}" expected "${expectedDocId}" but got "${doc?.id || 'none'}"`);
  }
};

const runScenarioTests = async () => {
  // 1) how to apply overtime => HR overtime
  assertDoc('how to apply overtime', 'hr_overtime_doc');

  // 2) how to take overtime => HR overtime via synonym rewrite
  assertDoc('how to take overtime', 'hr_overtime_doc');

  // 3) probation period policy => probation doc
  assertDoc('What is the probation period policy?', 'probation_policy_doc');

  // 4) translation not called when Solr already finds docs
  let solrCalls = 0;
  let translateCalls = 0;
  const primaryHit = await runBoundedSolrRetrieval({
    query: 'how to apply overtime',
    intentLabel: 'HR_PAYROLL_ATTENDANCE',
    userLanguage: 'en',
    bucketCorpusLanguage: 'ja',
    translationTimeoutMs: 400,
    runSolr: async (_query, mode) => {
      solrCalls += 1;
      if (mode === 'primary') return { docs: [{ id: 'hr_overtime_doc' }], numFound: 1, topScore: 11 };
      return { docs: [], numFound: 0, topScore: 0 };
    },
    buildFallbackQuery: (seed, label) => buildFallbackWildcardQuery(seed, label as any),
    translateQuery: async (query, targetLang) => {
      translateCalls += 1;
      return `${query}:${targetLang}`;
    },
  });
  if (primaryHit.result.docs.length !== 1) throw new Error('Expected primary Solr hit.');
  if (translateCalls !== 0) throw new Error(`Expected translate calls 0, got ${translateCalls}`);
  if (solrCalls !== 1) throw new Error(`Expected Solr calls 1, got ${solrCalls}`);

  // 5) max 2 Solr calls per query
  solrCalls = 0;
  translateCalls = 0;
  await runBoundedSolrRetrieval({
    query: 'how to take overtime',
    intentLabel: 'HR_PAYROLL_ATTENDANCE',
    userLanguage: 'en',
    bucketCorpusLanguage: 'ja',
    translationTimeoutMs: 400,
    runSolr: async () => {
      solrCalls += 1;
      return { docs: [], numFound: 0, topScore: 0 };
    },
    buildFallbackQuery: (seed, label) => buildFallbackWildcardQuery(seed, label as any),
    translateQuery: async (query, targetLang) => {
      translateCalls += 1;
      return `${query}:${targetLang}`;
    },
  });
  if (solrCalls > 2) throw new Error(`Expected <=2 Solr calls, got ${solrCalls}`);
  if (translateCalls > 1) throw new Error(`Expected <=1 translate call, got ${translateCalls}`);

  // 6) EN/JA equivalent management questions should choose the same style (policy summary).
  const retrievalQuery = '有価証券管理規程';
  const enStyle = hasExplicitProcedureCue(
    buildAnswerStyleProbeText('How are securities managed by the company?', retrievalQuery),
  );
  const jaStyle = hasExplicitProcedureCue(
    buildAnswerStyleProbeText('有価証券はどのように管理されますか？', retrievalQuery),
  );
  if (enStyle !== jaStyle) {
    throw new Error('Expected EN/JA style parity for equivalent securities-management queries.');
  }
  if (enStyle !== false) {
    throw new Error('Expected securities-management parity style to be policy_summary (not procedure).');
  }
};

void runScenarioTests()
  .then(() => {
    console.log('RAG pipeline regression checks passed.');
  })
  .catch((error) => {
    console.error('[RAG Regression] FAILED:', error?.message || error);
    process.exitCode = 1;
  });
=======
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type FetchCall = {
  url: string;
  body: any;
  method?: string;
};

const setupEnv = () => {
  process.env.RAG_LLM_QUERY_EXPANSION_ENABLED = '0';
  process.env.RAG_CROSS_LANGUAGE_BRIDGE_ENABLED = '0';
  process.env.RAG_QUERY_REPAIR_ENABLED = '0';
  process.env.RAG_HYDE_ENABLED = '0';
  process.env.RAG_SOLR_ENSURE_JA_ANALYZER = '0';
  process.env.RAG_VECTOR_RETRIEVAL_ENABLED = '1';
  process.env.RAG_VECTOR_ONLY_ON_LEXICAL_FAIL = '1';
  process.env.RAG_SEMANTIC_VECTOR_ONLY = '0';
  process.env.RAG_RESPONSE_CACHE_ENABLED = '0';
  process.env.RAG_LLM_RERANK_ENABLED = '0';
  process.env.RAG_SELECTIVE_RERANK_ENABLED = '0';
  process.env.RAG_QUERY_ROUTER_ENABLED = '1';
  process.env.FAST_EXTRACTIVE_MODE_ENABLED = '1';
  process.env.RAG_FAST_EXTRACTIVE_MIN_CONFIDENCE = '10';
  process.env.RAG_FAST_EXTRACTIVE_REQUIRED_DOC_COUNT = '1';
  process.env.RAG_FAST_EXTRACTIVE_REQUIRED_TOP_TERM_HITS = '1';
  process.env.RAG_FAST_EXTRACTIVE_TOP_DOC_ONLY = '1';
  process.env.CHAT_STRICT_REQUIRE_RAG = '1';
};

const makeResponse = (body: any, init?: { status?: number; text?: string }) => {
  const status = init?.status ?? 200;
  const text = init?.text ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'ERROR',
    json: async () => body,
    text: async () => text,
  } as any;
};

const withMockFetch = async <T>(handler: (calls: FetchCall[]) => Promise<T>): Promise<T> => {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input || '');
    const method = String(init?.method || 'GET').toUpperCase();
    let body: any = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, body, method });

    if (url.includes('/schema')) {
      return makeResponse({}, { status: 200, text: 'already exists' });
    }

    if (url.includes('/search/hybrid')) {
      if (body?.vector_only === true) {
        return makeResponse([
          {
            id: 'vector-only-doc',
            metadata: {
              DocumentName: 'Overtime process',
              department_code_s: 'HR',
            },
            page_content: '残業申請は上長承認後に提出します。',
            score: 0.93,
          },
        ]);
      }
      return makeResponse([
        {
          id: 'hybrid-doc',
          metadata: {
            DocumentName: 'Overtime manual',
            department_code_s: 'HR',
          },
          page_content: '残業申請は勤怠画面から行います。',
          score: 0.91,
        },
      ]);
    }

    if (url.includes('/solr/') && url.includes('/select')) {
      const query = String(url);
      if (query.includes('残業') || query.includes('overtime')) {
        return makeResponse({
          response: {
            numFound: 0,
            docs: [],
          },
        });
      }
      return makeResponse({
        response: {
          numFound: 0,
          docs: [],
        },
      });
    }

    return makeResponse({}, { status: 200 });
  }) as any;

  try {
    return await handler(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const main = async () => {
  setupEnv();

  const queryIntentRulesPath = path.resolve(process.cwd(), 'config', 'query_intent_rules.json');
  fs.writeFileSync(queryIntentRulesPath, JSON.stringify({
    general_chat: ['tell me', 'story'],
    translation_request: ['translate'],
    faq_lookup: ['faq'],
  }, null, 2));

  try {
    const { classifyQueryIntent } = await import('@/utils/queryIntentClassifier');
    const storyIntent = classifyQueryIntent('tell me a small story about sakura');
    assert.equal(storyIntent.intent, 'rag_query');
    assert.match(String(storyIntent.matchedRule || ''), /strict_rag_general_chat/);

    const { analyzeEnterpriseQuery } = await import('@/rag/query/queryAnalysis');
    const { routeDomainPrefilter } = await import('@/rag/retrieval/domainRouter');
    const { translateQueryForRetrievalDetailed } = await import('@/utils/query_translation');
    const { expandQuery } = await import('@/rag/query/expandQuery');
    const { buildResponseCacheKey, setCachedResponse } = await import('@/rag/cache/responseCache');
    const { retrieveDocumentsWithSolr } = await import('@/rag/retrieval/solrRetriever');
    const { runRagPipeline } = await import('@/rag/pipeline/ragPipeline');
    const { buildContextFromDocs } = await import('@/rag/context/contextBuilder');
    const { extractQueryTermsForRerank } = await import('@/rag/retrieval/reranker');
    const { formatFinalAnswerContract } = await import('@/rag/generation/finalAnswerFormatter');
    const { projectAppendOnlyStreamContent } = await import('@/service/chatStreamService');

    {
      const formatted = await formatFinalAnswerContract({
        userQuestion: 'what is the procedure to apply the commuter pass',
        userLanguage: 'en',
        retrievedDocs: [
          {
            id: 'commuter-pass-doc',
            title: '通勤手当支給規程',
            content_txt:
              '1. 通勤手当申請書を総務へ提出します。\n2. 承認後、定期券購入の領収書を提出します。',
          },
        ],
        sourceFileList: ['通勤手当支給規程'],
        answerCandidate: [
          'To apply for a commuter pass, follow these steps:',
          '1. Check eligibility.',
          '2. Obtain an application form from the transit authority.',
          '3. Provide proof of address.',
          '4. Submit the form online, in person, or by mail.',
        ].join('\n'),
      });
      assert.equal(formatted.isNegativeCase, true);
    }

    {
      const analysis = analyzeEnterpriseQuery('how to apply for overtime');
      assert.equal(analysis.queryType, 'procedural');
      assert.equal(analysis.domain, 'HR');
      assert.equal(analysis.languageMode, 'en');

      const routed = routeDomainPrefilter({
        query: 'how to apply for overtime',
        userLanguage: 'en',
      });
      assert.equal(routed.applied, true);
      assert.equal(routed.domainId, 'HR');

      const translated = await translateQueryForRetrievalDetailed('how to apply for overtime');
      assert.ok(translated.keywords.some((keyword) => /残業|勤怠|申請/.test(keyword)));
      assert.notEqual(translated.source, 'none');
    }

    {
      const analysis = analyzeEnterpriseQuery('what is the procedure for applying comuter pass');
      assert.equal(analysis.queryType, 'procedural');
      assert.equal(analysis.domain, 'GA');

      const expanded = await expandQuery({
        originalQueryText: 'what is the procedure for applying comuter pass',
        promptText: 'what is the procedure for applying comuter pass',
        userLanguage: 'en',
      });
      assert.ok(expanded.expandedQueries.some((query) => /通勤定期|定期券|通勤手当/.test(query)));
      assert.equal(expanded.domainDetected, 'GA');
    }

    await withMockFetch(async (calls) => {
      const result = await retrieveDocumentsWithSolr({
        queryForRAG: 'how to apply for overtime',
        multilingualRetrievalQueries: ['残業 申請', '残業申請'],
        userLanguage: 'en',
        retrievalIndexLanguage: 'multi',
        ragBackendUrl: 'http://mock-backend',
        onLog: () => undefined,
        solrRows: 4,
        maxSolrCalls: 4,
      });

      assert.ok(calls.some((call) => call.url.includes('/solr/') && call.url.includes('/select')));
      assert.ok(calls.some((call) => call.url.includes('/search/hybrid')));
      assert.ok(result.docs.length > 0);
    });

    {
    const extracted = buildContextFromDocs({
      docs: [
        {
          id: 'doc-1',
          title: 'Overtime request manual',
          content_txt:
            'Exment portal helper\n1. Open the attendance system.\n2. Submit overtime request to your manager.\n3. After approval, record the approved overtime in attendance.',
        },
      ],
      retrievalQuery: 'how to apply for overtime',
      maxChunks: 2,
      contextBudgetChars: 800,
      docContextChars: 500,
    });
    assert.ok(/Submit overtime request/i.test(extracted.documentContent));
    assert.ok(!/Exment/i.test(extracted.documentContent));
  }

    {
    const noisyTerms = extractQueryTermsForRerank('exment github overtime apply for leave');
    assert.ok(noisyTerms.some((term) => /overtime|leave/i.test(term)));
  }

    {
    const first = projectAppendOnlyStreamContent('', 'line one');
    assert.equal(first.mode, 'append');
    assert.equal(first.delta, 'line one');

    const second = projectAppendOnlyStreamContent('line one', 'line one\nline two');
    assert.equal(second.mode, 'append');
    assert.equal(second.delta, '\nline two');

    const rewrite = projectAppendOnlyStreamContent('line one', 'line two');
    assert.equal(rewrite.mode, 'ignore');
    assert.equal(rewrite.rewriteDetected, true);
  }

    {
    let generateAnswerCalled = false;
    const pipeline = await runRagPipeline({
      query: 'how to apply for overtime',
      prompt: 'how to apply for overtime',
      retrievalIndexLanguage: 'multi',
      retrieveDocuments: async () => ({
        docs: [
          {
            id: 'noise-doc',
            title: 'Portal overview',
            content_txt: 'Exment GitHub Microsoft Laravel admin dashboard portal interface system tool.',
            score: 48,
            file_name_s: 'noise.pdf',
          },
        ],
        retrievalQueryUsed: 'apply overtime',
        attemptedQueries: ['apply overtime'],
        queryTranslationApplied: false,
        translatedQuery: '',
        topScore: 48,
        topTermHits: 0,
        solrCallsCount: 1,
        translateCallsCount: 0,
        translateMs: 0,
        usedSemanticFallback: false,
      }),
      generateAnswer: async () => {
        generateAnswerCalled = true;
        throw new Error('generateAnswer should be blocked when evidence is only noisy metadata');
      },
    });

    assert.equal(generateAnswerCalled, false);
    assert.match(pipeline.answer, /available documents|利用可能な文書/);
    assert.equal(pipeline.metrics.llmMs, 0);
    assert.equal(pipeline.metrics.responseMode, 'blocked');
  }

    {
    let generateAnswerCalled = false;
    const pipeline = await runRagPipeline({
      query: 'how to apply for commuter pass',
      prompt: 'how to apply for commuter pass',
      retrievalIndexLanguage: 'multi',
      retrieveDocuments: async () => ({
        docs: [
          {
            id: 'commuter-pass-doc',
            title: '通勤手当支給規程',
            content_txt:
              '1. 通勤手当申請書を総務へ提出します。\n2. 承認後、定期券購入の領収書を提出します。',
            score: 48,
            file_name_s: 'commuter_pass_manual.pdf',
          },
        ],
        retrievalQueryUsed: '通勤手当申請手続き',
        attemptedQueries: ['通勤手当申請手続き'],
        queryTranslationApplied: true,
        translatedQuery: '通勤手当申請手続き',
        topScore: 48,
        topTermHits: 3,
        solrCallsCount: 1,
        translateCallsCount: 0,
        translateMs: 0,
        usedSemanticFallback: false,
      }),
      generateAnswer: async () => {
        generateAnswerCalled = true;
        throw new Error('generateAnswer should not run for a clear commuter-pass direct answer');
      },
    });

    assert.equal(generateAnswerCalled, false);
    assert.match(pipeline.answer, /通勤|定期券|申請/);
    assert.equal(pipeline.metrics.llmMs, 0);
    assert.equal(pipeline.metrics.responseMode, 'direct');
  }

    {
    let generateAnswerCalled = false;
    const pipeline = await runRagPipeline({
      query: 'how to apply for overtime',
      prompt: 'how to apply for overtime',
      retrievalIndexLanguage: 'multi',
      retrieveDocuments: async () => ({
        docs: [
          {
            id: 'hr-procedure',
            title: 'Overtime request manual',
            content_txt:
              '1. Open the attendance system.\n2. Submit overtime request to your manager.',
            score: 50,
            file_name_s: 'overtime_manual.pdf',
          },
        ],
        retrievalQueryUsed: 'overtime request manual',
        attemptedQueries: ['overtime request manual'],
        queryTranslationApplied: false,
        translatedQuery: '',
        topScore: 50,
        topTermHits: 3,
        solrCallsCount: 1,
        translateCallsCount: 0,
        translateMs: 0,
        usedSemanticFallback: false,
      }),
      generateAnswer: async () => {
        generateAnswerCalled = true;
        throw new Error('generateAnswer should not be called for procedural extractive path');
      },
    });

    assert.equal(generateAnswerCalled, false);
    assert.equal(pipeline.metrics.llmMs, 0);
    assert.ok(/overtime|残業/i.test(pipeline.answer));
    assert.equal(pipeline.metrics.responseMode, 'direct');
  }

    {
    let generateAnswerCalled = false;
    const pipeline = await runRagPipeline({
      query: 'how to apply for overtime',
      prompt: 'how to apply for overtime',
      retrievalIndexLanguage: 'multi',
      retrieveDocuments: async () => ({
        docs: [
          {
            id: 'weak-doc',
            title: 'General system note',
            content_txt: 'This page only describes the portal layout and unrelated UI text.',
            score: 1,
            file_name_s: 'ui_note.pdf',
          },
        ],
        retrievalQueryUsed: 'general system note',
        attemptedQueries: ['general system note'],
        queryTranslationApplied: false,
        translatedQuery: '',
        topScore: 1,
        topTermHits: 0,
        solrCallsCount: 1,
        translateCallsCount: 0,
        translateMs: 0,
        usedSemanticFallback: false,
      }),
      generateAnswer: async () => {
        generateAnswerCalled = true;
        throw new Error('generateAnswer should be blocked by low-confidence procedural gating');
      },
    });

    assert.equal(generateAnswerCalled, false);
    assert.match(pipeline.answer, /available documents|利用可能な文書/);
    assert.equal(pipeline.metrics.llmMs, 0);
    assert.equal(pipeline.metrics.responseMode, 'blocked');
  }

  {
    let generateAnswerCalled = false;
    const pipeline = await runRagPipeline({
      query: 'what is the leave policy',
      prompt: 'what is the leave policy',
      retrievalIndexLanguage: 'multi',
      allowLlmGeneration: false,
      retrieveDocuments: async () => ({
        docs: [
          {
            id: 'leave-policy',
            title: 'Leave policy',
            content_txt: 'Employees may take annual leave after manager approval.',
            score: 42,
            file_name_s: 'leave_policy.pdf',
          },
        ],
        retrievalQueryUsed: 'leave policy',
        attemptedQueries: ['leave policy'],
        queryTranslationApplied: false,
        translatedQuery: '',
        topScore: 42,
        topTermHits: 2,
        solrCallsCount: 1,
        translateCallsCount: 0,
        translateMs: 0,
        usedSemanticFallback: false,
      }),
      generateAnswer: async () => {
        generateAnswerCalled = true;
        throw new Error('generateAnswer should be skipped when allowLlmGeneration=false');
      },
    });

    assert.equal(generateAnswerCalled, false);
    assert.equal(pipeline.metrics.llmMs, 0);
    assert.equal(pipeline.metrics.responseMode, 'blocked');
  }

  {
    const query = 'how to apply for overtime';
    const docs = [
      {
        id: 'cache-doc',
        chunk_id_s: 'cache-chunk',
        updated_at_s: '2024-01-01',
        title: 'Portal overview',
        content_txt: 'This page only describes the portal layout and unrelated UI text.',
        score: 2,
        file_name_s: 'portal.pdf',
      },
    ];
    const expansion = await expandQuery({
      originalQueryText: query,
      promptText: query,
      userLanguage: 'en',
    });
    const cacheKey = buildResponseCacheKey({
      query,
      canonicalQuery: expansion.canonicalQuery,
      language: 'en',
      docIds: ['cache-doc'],
      chunkIds: ['cache-chunk'],
      indexVersion: '',
      documentLastUpdated: ['2024-01-01'],
    });
    setCachedResponse(cacheKey, {
      userLanguage: 'en',
      retrievalIndexLanguage: 'multi',
      normalizedQuery: query,
      queryForRAG: expansion.canonicalQuery,
      multilingualRetrievalQueries: expansion.multilingualRetrievalQueries,
      intentVariants: expansion.intentVariants,
      queryTranslationApplied: false,
      translateCallsCount: 0,
      queryTranslationMs: 0,
      retrievalQueryUsed: 'portal overview',
      prompt: 'unsafe cached synthesis',
      answer: 'unsafe cached synthesis',
      sources: [],
      metrics: {
        documentCount: 0,
        finalEvidenceChunkCount: 0,
        promptLength: 0,
        retrievalMs: 0,
        llmMs: 0,
        totalPipelineMs: 0,
        topScore: 0,
        topTermHits: 0,
        retrievalConfidence: 0,
        confidenceLevel: 'low',
        usedSemanticFallback: false,
        solrCallsCount: 0,
        queryType: 'procedural',
        domainDetected: 'HR',
        languageDetected: 'en',
        deterministicTermMapUsed: false,
      } as any,
    } as any);

    let generateAnswerCalled = false;
    const pipeline = await runRagPipeline({
      query,
      prompt: query,
      retrievalIndexLanguage: 'multi',
      retrieveDocuments: async () => ({
        docs,
        retrievalQueryUsed: 'apply overtime',
        attemptedQueries: ['apply overtime'],
        queryTranslationApplied: false,
        translatedQuery: '',
        topScore: 2,
        topTermHits: 0,
        solrCallsCount: 1,
        translateCallsCount: 0,
        translateMs: 0,
        usedSemanticFallback: false,
      }),
      generateAnswer: async () => {
        generateAnswerCalled = true;
        throw new Error('generateAnswer should not run when cache is bypassed on weak evidence');
      },
    });

    assert.equal(generateAnswerCalled, false);
    assert.notEqual(pipeline.answer, 'unsafe cached synthesis');
    assert.match(pipeline.answer, /available documents|利用可能な文書/);
  }

    console.log('RAG regression checks passed');
  } finally {
    fs.rmSync(queryIntentRulesPath, { force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
>>>>>>> theirs
