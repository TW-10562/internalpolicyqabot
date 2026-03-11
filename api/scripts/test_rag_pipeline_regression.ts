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
