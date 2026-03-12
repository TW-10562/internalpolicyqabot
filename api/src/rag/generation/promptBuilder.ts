import { getCompanyDisplayName } from '@/constants/branding';

const STRICT_NO_ANSWER_RESPONSE_EN =
  'The information could not be confirmed from the available documents.';
const STRICT_NO_ANSWER_RESPONSE_JA =
  '利用可能な文書からは、その情報を確認できませんでした。';

const strictNoAnswerForLanguage = (language: 'ja' | 'en'): string =>
  language === 'ja' ? STRICT_NO_ANSWER_RESPONSE_JA : STRICT_NO_ANSWER_RESPONSE_EN;

const buildLanguageOutputInstructions = (language: 'ja' | 'en'): string[] =>
  language === 'ja'
    ? [
        '回答は必ず日本語で作成してください。',
        '英語の文書が含まれていても、日本語で自然に説明してください。',
        '英語をそのまま出力しないでください。',
      ]
    : [
        'Respond ONLY in English.',
        'Even if the source documents contain Japanese text, translate and synthesize the information into natural English.',
        'Do not output Japanese text.',
      ];

export const noEvidenceReply = (language: 'ja' | 'en'): string =>
  strictNoAnswerForLanguage(language);

export const buildEnterpriseRagSystemPrompt = (
  language: 'ja' | 'en',
  hasRetrievedContext: boolean,
): string => {
  const strictNoAnswer = strictNoAnswerForLanguage(language);
  const companyDisplayName = getCompanyDisplayName(language);
  const lines = [
    'You are a policy-grounded assistant answering only from the provided retrieved documents.',
    '',
    'Rules:',
    '1. Answer only using the retrieved context.',
    '2. Do not invent facts, rules, thresholds, dates, or procedures.',
    `3. If the answer is not clearly supported by the retrieved context, reply exactly: "${strictNoAnswer}"`,
    language === 'ja'
      ? '4. ユーザーへの回答は必ず日本語のみで行ってください。'
      : '4. If the user asked in English, answer only in English.',
    language === 'ja'
      ? '5. 簡潔で明確な社内ポリシー回答にしてください。'
      : '5. Be concise, clear, and policy-focused.',
    '6. Rewrite the supported information clearly instead of copying raw document fragments.',
    '7. Preserve important policy terms, named entities, system names, and acronyms exactly when they appear in the retrieved context.',
    '8. Do not output headings, UI labels, menu names, links, or metadata from the source documents.',
    '9. Do not assume missing steps or conditions.',
    '10. Maintain any SOURCE/SOURCES citations provided by the system.',
    '',
    'Use the retrieved documents as the only source of truth.',
    `- Use "${companyDisplayName}" when the answer needs to name the organization.`,
    '- Preserve SOURCE/SOURCES citation wording exactly as provided by the system. Do not add or duplicate the footer in the answer body; runtime appends it.',
    `- If the documents do not contain enough information, reply exactly: "${strictNoAnswer}"`,
    '',
    'Output plain text only.',
  ];

  if (!hasRetrievedContext) {
    lines.push(`No document context is available. Reply exactly: "${strictNoAnswer}"`);
  }

  return lines.join('\n');
};

export const generationFailureReply = (language: 'ja' | 'en'): string =>
  language === 'ja'
    ? '関連する社内文書は見つかりましたが、回答生成に一時的な問題が発生しました。少し時間をおいて再度お試しください。'
    : 'Relevant internal documents were found, but answer generation failed due to a temporary model issue. Please try again.';

export const NO_EVIDENCE_FOUND_TOKEN = 'NO_EVIDENCE_FOUND';

export const groundedNoEvidenceReply = (language: 'ja' | 'en' = 'en'): string =>
  strictNoAnswerForLanguage(language);

export const buildEvidenceExtractionPrompt = (
  query: string,
  chunkText: string,
  documentTitle: string = 'Document',
  userLanguage: 'ja' | 'en' = 'en',
): string =>
  [
    'You are analyzing internal company documents.',
    '',
    'Question:',
    String(query || '').trim(),
    '',
    'Document title:',
    String(documentTitle || 'Document').trim(),
    '',
    'Document excerpt:',
    String(chunkText || '').trim(),
    '',
    'Task:',
    'Identify the information in the excerpt that answers the question.',
    'Rewrite the relevant statements clearly for downstream answer synthesis.',
    '',
    'Rules:',
    '- Use the document text only',
    '- Extract only information that is directly supported by the excerpt',
    '- Preserve important terminology from the document',
    '- Rewrite raw document wording into complete, readable bullet points',
    '- Do not copy raw headings, menu labels, or metadata',
    userLanguage === 'en'
      ? '- Output the bullet points in natural English only, even if the text is Japanese'
      : '- 出力は必ず自然な日本語にし、英語の断片をそのまま残さない',
    '- Do not output template words such as "Document", "Answer", or "Source"',
    '- Each bullet must contain a concrete fact, rule, requirement, or condition from the excerpt',
    '- Do not output truncated or incomplete clauses',
    '',
    'Output format:',
    '',
    'Answer:',
    '• relevant point',
    '• relevant point',
    '• relevant point',
    '',
    `If the excerpt truly does not contain the answer, return exactly: ${NO_EVIDENCE_FOUND_TOKEN}`,
  ].join('\n');

export const buildGroundedAnswerPrompt = (
  query: string,
  extractedSentences: string[],
  userLanguage: 'ja' | 'en',
): string => {
  const strictNoAnswer = strictNoAnswerForLanguage(userLanguage);
  const evidenceText = (extractedSentences || [])
    .map((line) => `- ${String(line || '').trim()}`)
    .filter((line) => line !== '-')
    .join('\n');

  return [
    'You are answering using only evidence from company documents.',
    '',
    'Evidence:',
    evidenceText || `- ${NO_EVIDENCE_FOUND_TOKEN}`,
    '',
    'Question:',
    String(query || '').trim(),
    '',
    'Rules:',
    '- Use only the evidence above.',
    '- Do not invent any facts.',
    '- Synthesize the evidence into a clear answer to the question.',
    '- If multiple relevant points exist, summarize them clearly.',
    '- Preserve important terminology from the evidence.',
    '- Do NOT copy raw document fragments.',
    '- Do not output headings, UI labels, menu names, or metadata.',
    '- Do not assume steps unless the evidence explicitly describes them.',
    '- When the evidence already answers the question, stay close to the evidence wording and rewrite it clearly.',
    `- If evidence is insufficient, return exactly: "${strictNoAnswer}"`,
    '- Keep the answer concise but informative.',
    '- Do not include SOURCE/SOURCES footer in the body.',
    ...buildLanguageOutputInstructions(userLanguage),
  ].join('\n');
};

export const buildDirectContextAnswerPrompt = (
  query: string,
  context: string,
  userLanguage: 'ja' | 'en',
): string => {
  const strictNoAnswer = strictNoAnswerForLanguage(userLanguage);
  const answerClearlyInstruction =
    userLanguage === 'ja'
      ? '• わかりやすく回答する'
      : '• Answer clearly';
  const rewriteFragmentsInstruction =
    userLanguage === 'ja'
      ? '• 断片的な文書表現は自然な文章に書き直す'
      : '• Rewrite fragmented text into clear sentences';
  const noRawFragmentsInstruction =
    userLanguage === 'ja'
      ? '• 文書の断片をそのまま繰り返さない'
      : '• Do not repeat raw document fragments';
  const languageInstructions = buildLanguageOutputInstructions(userLanguage).map(
    (line) => `• ${line}`,
  );

  return [
    'SYSTEM:',
    'Answer using only the document context.',
    'Rewrite fragmented text into clear sentences.',
    '',
    'USER QUESTION:',
    String(query || '').trim(),
    '',
    'DOCUMENT CONTEXT:',
    String(context || '').trim(),
    '',
    'Instructions:',
    answerClearlyInstruction,
    rewriteFragmentsInstruction,
    noRawFragmentsInstruction,
    ...languageInstructions,
    '',
    'Additional Rules:',
    '- Use only the provided context.',
    '- Preserve important terminology from the context.',
    '- Do not output headings, UI labels, menu names, links, or metadata from the source.',
    '- Do not invent facts or assume procedures that are not explicitly stated in the context.',
    '- Do not include unrelated topics.',
    `- If context is insufficient, return exactly: "${strictNoAnswer}"`,
    '- Do not include SOURCE/SOURCES footer in the body.',
  ].join('\n');
};
